[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath,

  [Parameter(Mandatory = $true)]
  [string]$IssuerUrl,

  [int]$Port = 3100,

  [int]$TrustProxyHops = 1,

  [string]$TaskName = 'Nick Drive MCP',

  [string]$SecretPath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\hosted-secrets.json'),

  [string]$StorePath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\team-store.json'),

  [switch]$AllowDirty,

  [switch]$SkipBuild,

  [switch]$StartNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Port -lt 1 -or $Port -gt 65535) {
  throw "Invalid port: $Port"
}
if ($TrustProxyHops -lt 0) {
  throw "Invalid TrustProxyHops: $TrustProxyHops"
}

$productionBaseline = '49c06c4c36e1c0792c2af61b5bc435fe00935403'
$repo = (Resolve-Path -LiteralPath $RepoPath).Path
$runScript = Join-Path $repo 'scripts\windows\run-local-host.ps1'
if (-not (Test-Path -LiteralPath $runScript -PathType Leaf)) {
  throw "Windows runtime wrapper not found: $runScript"
}
if (-not (Test-Path -LiteralPath $SecretPath -PathType Leaf)) {
  throw "Protected Google OAuth Web credentials not found: $SecretPath"
}

try {
  $issuer = [Uri]$IssuerUrl
} catch {
  throw "Invalid issuer URL: $IssuerUrl"
}
if ($issuer.Scheme -ne 'https' -or $issuer.AbsolutePath -ne '/' -or $issuer.Query -or $issuer.Fragment) {
  throw 'IssuerUrl must be a fixed HTTPS root origin such as https://drive-mcp.example.com.'
}

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$npmCommand = Get-Command npm.cmd -ErrorAction Stop
$gitCommand = Get-Command git.exe -ErrorAction Stop
$powerShellCommand = Get-Command powershell.exe -ErrorAction Stop

$existingListener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($existingListener.Count -gt 0) {
  $owners = ($existingListener.OwningProcess | Sort-Object -Unique) -join ', '
  throw "Port $Port already has a listener (PID(s): $owners). Remove/stop the existing Nick Drive MCP runtime before installing this task."
}
$nodeVersionText = (& $nodeCommand.Source --version).Trim()
$nodeMajor = [int](($nodeVersionText -replace '^v', '').Split('.')[0])
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required; found $nodeVersionText."
}

& $gitCommand.Source -C $repo merge-base --is-ancestor $productionBaseline HEAD
if ($LASTEXITCODE -ne 0) {
  throw "Current checkout does not contain production baseline $productionBaseline."
}
if (-not $AllowDirty) {
  $dirty = & $gitCommand.Source -C $repo status --porcelain
  if ($dirty) {
    throw 'Repository has uncommitted changes. Commit/stash them or rerun with -AllowDirty after reviewing the diff.'
  }
}

if (-not $SkipBuild) {
  Push-Location $repo
  try {
    & $npmCommand.Source ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
    & $npmCommand.Source run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

$runtimeDirectory = Split-Path -Parent $StorePath
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $identity,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $runtimeDirectory -AclObject $acl

function Quote-TaskArgument([string]$Value) {
  return '"' + $Value.Replace('"', '""') + '"'
}

$issuerOrigin = $issuer.GetLeftPart([UriPartial]::Authority)
$taskArguments = @(
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-File', (Quote-TaskArgument $runScript),
  '-RepoPath', (Quote-TaskArgument $repo),
  '-IssuerUrl', (Quote-TaskArgument $issuerOrigin),
  '-NodePath', (Quote-TaskArgument $nodeCommand.Source),
  '-Port', [string]$Port,
  '-SecretPath', (Quote-TaskArgument $SecretPath),
  '-StorePath', (Quote-TaskArgument $StorePath),
  '-TrustProxyHops', [string]$TrustProxyHops
) -join ' '

$action = New-ScheduledTaskAction -Execute $powerShellCommand.Source -Argument $taskArguments -WorkingDirectory $repo
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType S4U -RunLevel Limited
$settingsParams = @{
  StartWhenAvailable = $true
  RestartCount = 999
  RestartInterval = (New-TimeSpan -Minutes 1)
  ExecutionTimeLimit = [TimeSpan]::Zero
  MultipleInstances = 'IgnoreNew'
  AllowStartIfOnBatteries = $true
  DontStopIfGoingOnBatteries = $true
}
$settings = New-ScheduledTaskSettingsSet @settingsParams
$taskParams = @{
  Action = $action
  Trigger = @($startupTrigger, $logonTrigger)
  Principal = $principal
  Settings = $settings
  Description = 'Persistent local Nick Drive MCP hosted runtime. Secrets remain DPAPI-protected outside the repository.'
}
$task = New-ScheduledTask @taskParams
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName

  $ready = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Seconds 1
    try {
      $requestParams = @{
        Uri = "http://127.0.0.1:$Port/mcp"
        Method = 'Get'
        Headers = @{ Accept = 'text/event-stream' }
        UseBasicParsing = $true
        TimeoutSec = 2
        ErrorAction = 'Stop'
      }
      Invoke-WebRequest @requestParams | Out-Null
    } catch {
      $response = $_.Exception.Response
      if ($response -and [int]$response.StatusCode -eq 401) {
        $ready = $true
        break
      }
      continue
    }
  }

  if (-not $ready) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    throw "Scheduled task was registered but the local MCP listener did not return the expected HTTP 401 within 20 seconds. LastTaskResult=$($info.LastTaskResult)."
  }
}

Write-Output "Scheduled task installed: $TaskName"
Write-Output "Local origin: http://127.0.0.1:$Port"
Write-Output "Public issuer: $issuerOrigin"
Write-Output "Google callback to register exactly: $issuerOrigin/oauth/google/callback"
Write-Output "ChatGPT MCP endpoint: $issuerOrigin/mcp"
