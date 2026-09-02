[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$TaskName = 'Nick Drive MCP',

  [string]$RepoPath,

  [string]$SecretPath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\hosted-secrets.json'),

  [string]$StorePath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\team-store.json'),

  [switch]$RemoveProtectedCredentials,

  [switch]$RemoveTeamStore
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$comparison = [System.StringComparison]::OrdinalIgnoreCase

function Get-TaskRuntimeConfig {
  param([Parameter(Mandatory = $true)]$Task)
  $action = @($Task.Actions) | Select-Object -First 1
  if (-not $action) { return $null }
  $arguments = [string]$action.Arguments
  $fileMatch = [regex]::Match($arguments, '(?i)(?:^|\s)-File\s+"([^"]+)"')
  $storeMatch = [regex]::Match($arguments, '(?i)(?:^|\s)-StorePath\s+"([^"]+)"')
  $repoMatch = [regex]::Match($arguments, '(?i)(?:^|\s)-RepoPath\s+"([^"]+)"')
  if (-not $fileMatch.Success -or -not $storeMatch.Success -or -not $repoMatch.Success) { return $null }
  return [pscustomobject]@{
    RunScript = $fileMatch.Groups[1].Value
    StorePath = $storeMatch.Groups[1].Value
    RepoPath = $repoMatch.Groups[1].Value
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
        $commandLine.IndexOf($Config.StorePath, $comparison) -ge 0
      }
  )
}

function Get-ManagedNodeProcesses {
  param([Parameter(Mandatory = $true)][string]$ManagedRepo)
  $launcher = Join-Path $ManagedRepo 'scripts\start-hosted.js'
  $entrypoint = Join-Path $ManagedRepo 'dist\index.js'
  return @(
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $commandLine = [string]$_.CommandLine
        -not [string]::IsNullOrWhiteSpace($commandLine) -and
        ($commandLine.IndexOf($launcher, $comparison) -ge 0 -or
         $commandLine.IndexOf($entrypoint, $comparison) -ge 0)
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
  if ($taskkillExit -ne 0) { throw "taskkill failed for managed PID $ProcessId with exit code $taskkillExit." }
  throw "Managed PID $ProcessId remained alive after process-tree termination."
}

function Stop-ManagedNodeProcesses {
  param([Parameter(Mandatory = $true)][string]$ManagedRepo)
  for ($pass = 0; $pass -lt 3; $pass++) {
    $matches = @(Get-ManagedNodeProcesses -ManagedRepo $ManagedRepo)
    if ($matches.Count -eq 0) { return }
    $ids = @{}
    foreach ($process in $matches) { $ids[[int]$process.ProcessId] = $true }
    $roots = @($matches | Where-Object { -not $ids.ContainsKey([int]$_.ParentProcessId) })
    foreach ($root in $roots) { Stop-ProcessTree -ProcessId ([int]$root.ProcessId) }
  }
  $remaining = @(Get-ManagedNodeProcesses -ManagedRepo $ManagedRepo)
  if ($remaining.Count -gt 0) {
    throw "Managed Nick Drive MCP Node runtime remained after cleanup. PID(s): $(($remaining.ProcessId | Sort-Object) -join ', ')"
  }
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$config = if ($task) { Get-TaskRuntimeConfig -Task $task } else { $null }
$effectiveRepo = $null
if (-not [string]::IsNullOrWhiteSpace($RepoPath)) {
  $effectiveRepo = (Resolve-Path -LiteralPath $RepoPath).Path
}
if ($config -and -not [string]::IsNullOrWhiteSpace([string]$config.RepoPath)) {
  $taskRepo = (Resolve-Path -LiteralPath ([string]$config.RepoPath)).Path
  if ($effectiveRepo -and -not $effectiveRepo.Equals($taskRepo, $comparison)) {
    throw "Explicit RepoPath does not match the registered task RepoPath. Explicit=$effectiveRepo Registered=$taskRepo"
  }
  $effectiveRepo = $taskRepo
}

if ($task) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Stop exact process trees and unregister scheduled task')) {
    if ($config) {
      $hosts = @(Find-TaskHostProcesses -Config $config)
      foreach ($hostProcess in $hosts) { Stop-ProcessTree -ProcessId ([int]$hostProcess.ProcessId) }
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($effectiveRepo) { Stop-ManagedNodeProcesses -ManagedRepo $effectiveRepo }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
} elseif ($effectiveRepo) {
  if ($PSCmdlet.ShouldProcess($effectiveRepo, 'Stop exact orphaned Nick Drive MCP Node runtime')) {
    Stop-ManagedNodeProcesses -ManagedRepo $effectiveRepo
  }
} else {
  Write-Output "Scheduled task not present and no RepoPath supplied: $TaskName"
}

if ($RemoveProtectedCredentials -and (Test-Path -LiteralPath $SecretPath -PathType Leaf)) {
  if ($PSCmdlet.ShouldProcess($SecretPath, 'Delete DPAPI-protected Google OAuth credentials')) {
    Remove-Item -LiteralPath $SecretPath -Force
  }
}
if ($RemoveTeamStore -and (Test-Path -LiteralPath $StorePath -PathType Leaf)) {
  if ($PSCmdlet.ShouldProcess($StorePath, 'Delete team store containing Google refresh grants')) {
    Remove-Item -LiteralPath $StorePath -Force
  }
}

Write-Output 'Local host task removal complete.'
if (-not $RemoveProtectedCredentials) { Write-Output "Protected OAuth credentials preserved: $SecretPath" }
if (-not $RemoveTeamStore) { Write-Output "Team store preserved: $StorePath" }
