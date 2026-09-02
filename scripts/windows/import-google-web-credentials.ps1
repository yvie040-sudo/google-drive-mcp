[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [string]$OutputPath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\hosted-secrets.json'),

  [switch]$DeleteSource
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$isWindowsHost = if ($PSVersionTable.PSEdition -eq 'Core') {
  [bool]$IsWindows
} else {
  $env:OS -eq 'Windows_NT'
}
if (-not $isWindowsHost) {
  throw 'This script is Windows-only because it relies on Windows DPAPI through ConvertFrom-SecureString.'
}

$resolvedInput = (Resolve-Path -LiteralPath $InputPath).Path
$raw = Get-Content -LiteralPath $resolvedInput -Raw | ConvertFrom-Json

if (-not $raw.web) {
  throw 'Expected a Google OAuth Web application credentials JSON object with a top-level "web" property.'
}

$clientId = [string]$raw.web.client_id
$clientSecret = [string]$raw.web.client_secret
if ([string]::IsNullOrWhiteSpace($clientId) -or [string]::IsNullOrWhiteSpace($clientSecret)) {
  throw 'The Google OAuth Web credentials file does not contain both client_id and client_secret.'
}

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$secureSecret = ConvertTo-SecureString -String $clientSecret -AsPlainText -Force
$protectedSecret = ConvertFrom-SecureString -SecureString $secureSecret

$roundTripSecure = ConvertTo-SecureString -String $protectedSecret
$roundTripBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($roundTripSecure)
try {
  $roundTripSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($roundTripBstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($roundTripBstr)
}
if ($roundTripSecret -cne $clientSecret) {
  throw 'DPAPI round-trip verification failed. The source credential file was left untouched.'
}
$roundTripSecret = $null

$payload = [ordered]@{
  version = 1
  credential_type = 'google_oauth_web'
  client_id = $clientId
  client_secret_dpapi = $protectedSecret
  created_utc = [DateTime]::UtcNow.ToString('o')
}

$tempPath = "$OutputPath.tmp.$PID"
$payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $tempPath -Encoding UTF8
Move-Item -LiteralPath $tempPath -Destination $OutputPath -Force

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $identity,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $OutputPath -AclObject $acl

if ($DeleteSource) {
  Remove-Item -LiteralPath $resolvedInput -Force
}

$clientSecret = $null
Write-Output "Protected Google OAuth Web credentials stored at: $OutputPath"
Write-Output 'The client secret was not printed and is DPAPI-bound to the current Windows user.'
