[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath,

  [int]$Port = 3100,

  [string]$TaskName = 'Nick Drive MCP Relay',

  [string]$SecretPath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\relay-secrets.json'),

  [switch]$SkipInstall,

  [switch]$StartNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Port -lt 1 -or $Port -gt 65535) { throw "Invalid port: $Port" }
$repo = (Resolve-Path -LiteralPath $RepoPath).Path
$runScript = Join-Path $repo 'scripts\windows\run-relay-client.ps1'
$relayDir = Join-Path $repo 'infra\cloudflare-relay'
$runner = Join-Path $relayDir 'src\bridge-runner.mjs'
if (-not (Test-Path -LiteralPath $runScript -PathType Leaf)) { throw "Relay runtime wrapper not found: $runScript" }
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "Relay runner not found: $runner" }
if (-not (Test-Path -LiteralPath $SecretPath -PathType Leaf)) { throw "Protected relay credentials not found: $SecretPath" }

$config = Get-Content -LiteralPath $SecretPath -Raw | ConvertFrom-Json
if ([int]$config.version -ne 1 -or [string]$config.credential_type -ne 'cloudflare_drive_relay') {
  throw 'Unsupported protected relay credential file format.'
}
$relayUrl = [Uri]([string]$config.relay_url)
if ($relayUrl.Scheme -ne 'wss' -or $relayUrl.AbsolutePath -ne '/__relay/ws') { throw 'Protected relay URL is invalid.' }
$healthUrl = "https://$($relayUrl.Authority)/__relay/health"

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$npmCommand = Get-Command npm.cmd -ErrorAction Stop
$powerShellCommand = Get-Command powershell.exe -ErrorAction Stop
if (-not $SkipInstall) {
  & $npmCommand.Source ci --prefix $relayDir --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "Relay runtime npm ci failed with exit code $LASTEXITCODE." }
}

function Quote-TaskArgument([string]$Value) {
  return '"' + $Value.Replace('"', '""') + '"'
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskArguments = @(
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-File', (Quote-TaskArgument $runScript),
  '-RepoPath', (Quote-TaskArgument $repo),
  '-NodePath', (Quote-TaskArgument $nodeCommand.Source),
  '-Port', [string]$Port,
  '-SecretPath', (Quote-TaskArgument $SecretPath)
) -join ' '

$action = New-ScheduledTaskAction -Execute $powerShellCommand.Source -Argument $taskArguments -WorkingDirectory $repo
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries
$task = New-ScheduledTask `
  -Action $action `
  -Trigger @($startupTrigger, $logonTrigger) `
  -Principal $principal `
  -Settings $settings `
  -Description 'Persistent outbound Cloudflare Worker relay for Nick Drive MCP. The bridge key remains DPAPI-protected outside the task arguments.'
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    try {
      $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      if ([int]$response.StatusCode -eq 200) {
        $payload = $response.Content | ConvertFrom-Json
        if ($payload.bridge_connected -eq $true) {
          $ready = $true
          break
        }
      }
    } catch {}
  }
  if (-not $ready) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    throw "Relay task was registered but public health never reported bridge_connected=true. LastTaskResult=$($info.LastTaskResult)."
  }
}

Write-Output "Scheduled task installed: $TaskName"
Write-Output "Relay health: $healthUrl"
Write-Output "Local origin: http://127.0.0.1:$Port"
