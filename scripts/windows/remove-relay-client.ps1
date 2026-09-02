[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$TaskName = 'Nick Drive MCP Relay',

  [string]$RepoPath,

  [string]$RuntimePath,

  [string]$SecretPath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\relay-secrets.json'),

  [switch]$RemoveProtectedRelaySecret
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$comparison = [System.StringComparison]::OrdinalIgnoreCase

function Get-TaskRelayConfig {
  param([Parameter(Mandatory = $true)]$Task)
  $action = @($Task.Actions) | Select-Object -First 1
  if (-not $action) { return $null }
  $arguments = [string]$action.Arguments
  $fileMatch = [regex]::Match($arguments, '(?i)(?:^|\s)-File\s+"([^"]+)"')
  $secretMatch = [regex]::Match($arguments, '(?i)(?:^|\s)-SecretPath\s+"([^"]+)"')
  $repoMatch = [regex]::Match($arguments, '(?i)(?:^|\s)-RepoPath\s+"([^"]+)"')
  $runtimeMatch = [regex]::Match($arguments, '(?i)(?:^|\s)-RuntimePath\s+"([^"]+)"')
  if (-not $fileMatch.Success -or -not $secretMatch.Success -or -not $repoMatch.Success) { return $null }
  return [pscustomobject]@{
    RunScript = $fileMatch.Groups[1].Value
    SecretPath = $secretMatch.Groups[1].Value
    RepoPath = $repoMatch.Groups[1].Value
    RuntimePath = if ($runtimeMatch.Success) { $runtimeMatch.Groups[1].Value } else { $null }
  }
}

function Find-TaskHostProcesses {
  param([Parameter(Mandatory = $true)]$Config)
  return @(
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $commandLine = [string]$_.CommandLine
        -not [string]::IsNullOrWhiteSpace($commandLine) -and
        $commandLine.IndexOf($Config.RunScript, $comparison) -ge 0 -and
        $commandLine.IndexOf($Config.SecretPath, $comparison) -ge 0
      }
  )
}

function Get-ManagedBridgeProcesses {
  param(
    [string]$ManagedRepo,
    [string]$ManagedRuntime
  )
  $legacyRunner = if ($ManagedRepo) { Join-Path $ManagedRepo 'infra\cloudflare-relay\src\bridge-runner.mjs' } else { $null }
  $runtimeRunner = if ($ManagedRuntime) { Join-Path $ManagedRuntime 'src\bridge-runner.mjs' } else { $null }
  return @(
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $commandLine = [string]$_.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
        ($legacyRunner -and $commandLine.IndexOf($legacyRunner, $comparison) -ge 0) -or
        ($runtimeRunner -and $commandLine.IndexOf($runtimeRunner, $comparison) -ge 0)
      }
  )
}

function Stop-ProcessTree {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  & $taskkill /PID $ProcessId /T /F | Out-Null
  $taskkillExit = $LASTEXITCODE
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 100
  }
  if ($taskkillExit -ne 0) { throw "taskkill failed for relay PID $ProcessId with exit code $taskkillExit." }
  throw "Relay PID $ProcessId remained alive after process-tree termination."
}

function Stop-ManagedBridgeProcesses {
  param(
    [string]$ManagedRepo,
    [string]$ManagedRuntime
  )
  for ($pass = 0; $pass -lt 3; $pass++) {
    $matches = @(Get-ManagedBridgeProcesses -ManagedRepo $ManagedRepo -ManagedRuntime $ManagedRuntime)
    if ($matches.Count -eq 0) { return }
    $ids = @{}
    foreach ($process in $matches) { $ids[[int]$process.ProcessId] = $true }
    $roots = @($matches | Where-Object { -not $ids.ContainsKey([int]$_.ParentProcessId) })
    foreach ($root in $roots) { Stop-ProcessTree -ProcessId ([int]$root.ProcessId) }
  }
  $remaining = @(Get-ManagedBridgeProcesses -ManagedRepo $ManagedRepo -ManagedRuntime $ManagedRuntime)
  if ($remaining.Count -gt 0) {
    throw "Managed relay bridge remained after cleanup. PID(s): $(($remaining.ProcessId | Sort-Object) -join ', ')"
  }
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$config = if ($task) { Get-TaskRelayConfig -Task $task } else { $null }
$effectiveRepo = $null
$effectiveRuntime = $null
if (-not [string]::IsNullOrWhiteSpace($RepoPath)) { $effectiveRepo = (Resolve-Path -LiteralPath $RepoPath).Path }
if (-not [string]::IsNullOrWhiteSpace($RuntimePath)) { $effectiveRuntime = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($RuntimePath)) }
if ($config -and -not [string]::IsNullOrWhiteSpace([string]$config.RepoPath)) {
  $taskRepo = (Resolve-Path -LiteralPath ([string]$config.RepoPath)).Path
  if ($effectiveRepo -and -not $effectiveRepo.Equals($taskRepo, $comparison)) {
    throw "Explicit RepoPath does not match the registered relay task RepoPath. Explicit=$effectiveRepo Registered=$taskRepo"
  }
  $effectiveRepo = $taskRepo
}
if ($config -and -not [string]::IsNullOrWhiteSpace([string]$config.RuntimePath)) {
  $taskRuntime = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$config.RuntimePath))
  if ($effectiveRuntime -and -not $effectiveRuntime.Equals($taskRuntime, $comparison)) {
    throw "Explicit RuntimePath does not match the registered relay task RuntimePath. Explicit=$effectiveRuntime Registered=$taskRuntime"
  }
  $effectiveRuntime = $taskRuntime
}

if ($task) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Stop exact relay process trees and unregister scheduled task')) {
    if ($config) {
      $hosts = @(Find-TaskHostProcesses -Config $config)
      foreach ($hostProcess in $hosts) { Stop-ProcessTree -ProcessId ([int]$hostProcess.ProcessId) }
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-ManagedBridgeProcesses -ManagedRepo $effectiveRepo -ManagedRuntime $effectiveRuntime
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
} elseif ($effectiveRepo -or $effectiveRuntime) {
  $target = if ($effectiveRuntime) { $effectiveRuntime } else { $effectiveRepo }
  if ($PSCmdlet.ShouldProcess($target, 'Stop exact orphaned bridge-runner.mjs processes')) {
    Stop-ManagedBridgeProcesses -ManagedRepo $effectiveRepo -ManagedRuntime $effectiveRuntime
  }
} else {
  Write-Output "Scheduled task not present and no RepoPath/RuntimePath supplied: $TaskName"
}

if ($RemoveProtectedRelaySecret -and (Test-Path -LiteralPath $SecretPath -PathType Leaf)) {
  if ($PSCmdlet.ShouldProcess($SecretPath, 'Delete DPAPI-protected relay credentials')) { Remove-Item -LiteralPath $SecretPath -Force }
}

Write-Output 'Relay task removal complete.'
if (-not $RemoveProtectedRelaySecret) { Write-Output "Protected relay credentials preserved: $SecretPath" }
