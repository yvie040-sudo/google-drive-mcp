[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$TaskName = 'Nick Drive MCP',

  [string]$SecretPath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\hosted-secrets.json'),

  [string]$StorePath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\team-store.json'),

  [switch]$RemoveProtectedCredentials,

  [switch]$RemoveTeamStore
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Find-TaskHostProcess {
  param(
    [Parameter(Mandatory = $true)]
    $Task
  )

  $action = @($Task.Actions) | Select-Object -First 1
  if (-not $action) {
    return $null
  }

  $arguments = [string]$action.Arguments
  $fileMatch = [regex]::Match($arguments, '(?i)(?:^|\s)-File\s+"([^"]+)"')
  $storeMatch = [regex]::Match($arguments, '(?i)(?:^|\s)-StorePath\s+"([^"]+)"')
  if (-not $fileMatch.Success -or -not $storeMatch.Success) {
    return $null
  }

  $runScript = $fileMatch.Groups[1].Value
  $taskStorePath = $storeMatch.Groups[1].Value
  $comparison = [System.StringComparison]::OrdinalIgnoreCase

  $matches = @(
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $commandLine = [string]$_.CommandLine
        -not [string]::IsNullOrWhiteSpace($commandLine) -and
        $commandLine.IndexOf($runScript, $comparison) -ge 0 -and
        $commandLine.IndexOf($taskStorePath, $comparison) -ge 0
      }
  )

  if ($matches.Count -gt 1) {
    $pids = ($matches.ProcessId | Sort-Object) -join ', '
    throw "Refusing to terminate an ambiguous Scheduled Task process tree. Matching host PIDs: $pids"
  }

  if ($matches.Count -eq 1) {
    return $matches[0]
  }
  return $null
}

function Stop-ProcessTree {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
  )

  $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  & $taskkill /PID $ProcessId /T /F | Out-Null
  $taskkillExit = $LASTEXITCODE

  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
      return
    }
    Start-Sleep -Milliseconds 100
  }

  if ($taskkillExit -ne 0) {
    throw "taskkill failed for Scheduled Task host PID $ProcessId with exit code $taskkillExit."
  }
  throw "Scheduled Task host PID $ProcessId remained alive after process-tree termination."
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Stop process tree and unregister scheduled task')) {
    $hostProcess = Find-TaskHostProcess -Task $task
    if ($hostProcess) {
      Stop-ProcessTree -ProcessId ([int]$hostProcess.ProcessId)
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
} else {
  Write-Output "Scheduled task not present: $TaskName"
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
if (-not $RemoveProtectedCredentials) {
  Write-Output "Protected OAuth credentials preserved: $SecretPath"
}
if (-not $RemoveTeamStore) {
  Write-Output "Team store preserved: $StorePath"
}
