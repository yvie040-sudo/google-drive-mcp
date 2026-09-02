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

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and unregister scheduled task')) {
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
