[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$TaskName = 'Nick Drive MCP Relay',

  [string]$SecretPath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\relay-secrets.json'),

  [switch]$RemoveProtectedRelaySecret
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Find-TaskHostProcess {
  param([Parameter(Mandatory = $true)]$Task)
  $action = @($Task.Actions) | Select-Object -First 1
  if (-not $action) { return $null }
  $arguments = [string]$action.Arguments
  $fileMatch = [regex]::Match($arguments, '(?i)(?:^|\s)-File\s+"([^"]+)"')
  $secretMatch = [regex]::Match($arguments, '(?i)(?:^|\s)-SecretPath\s+"([^"]+)"')
  if (-not $fileMatch.Success -or -not $secretMatch.Success) { return $null }
  $runScript = $fileMatch.Groups[1].Value
  $taskSecretPath = $secretMatch.Groups[1].Value
  $comparison = [System.StringComparison]::OrdinalIgnoreCase
  $matches = @(
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $commandLine = [string]$_.CommandLine
        -not [string]::IsNullOrWhiteSpace($commandLine) -and
        $commandLine.IndexOf($runScript, $comparison) -ge 0 -and
        $commandLine.IndexOf($taskSecretPath, $comparison) -ge 0
      }
  )
  if ($matches.Count -gt 1) {
    throw "Refusing to terminate an ambiguous relay task process tree. Matching host PIDs: $(($matches.ProcessId | Sort-Object) -join ', ')"
  }
  if ($matches.Count -eq 1) { return $matches[0] }
  return $null
}

function Stop-ProcessTree {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  & $taskkill /PID $ProcessId /T /F | Out-Null
  $taskkillExit = $LASTEXITCODE
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 100
  }
  if ($taskkillExit -ne 0) { throw "taskkill failed for relay task host PID $ProcessId with exit code $taskkillExit." }
  throw "Relay task host PID $ProcessId remained alive after process-tree termination."
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Stop exact process tree and unregister relay scheduled task')) {
    $hostProcess = Find-TaskHostProcess -Task $task
    if ($hostProcess) { Stop-ProcessTree -ProcessId ([int]$hostProcess.ProcessId) }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
} else {
  Write-Output "Scheduled task not present: $TaskName"
}

if ($RemoveProtectedRelaySecret -and (Test-Path -LiteralPath $SecretPath -PathType Leaf)) {
  if ($PSCmdlet.ShouldProcess($SecretPath, 'Delete DPAPI-protected relay credentials')) {
    Remove-Item -LiteralPath $SecretPath -Force
  }
}

Write-Output 'Relay task removal complete.'
if (-not $RemoveProtectedRelaySecret) { Write-Output "Protected relay credentials preserved: $SecretPath" }
