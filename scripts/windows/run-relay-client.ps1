[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath,

  [string]$RuntimePath,

  [Parameter(Mandatory = $true)]
  [string]$NodePath,

  [int]$Port = 3100,

  [string]$SecretPath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\relay-secrets.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Port -lt 1 -or $Port -gt 65535) { throw "Invalid port: $Port" }
$repo = (Resolve-Path -LiteralPath $RepoPath).Path
$node = (Resolve-Path -LiteralPath $NodePath).Path
if ([string]::IsNullOrWhiteSpace($RuntimePath)) {
  $runner = Join-Path $repo 'infra\cloudflare-relay\src\bridge-runner.mjs'
} else {
  $runtime = (Resolve-Path -LiteralPath $RuntimePath).Path
  $runner = Join-Path $runtime 'src\bridge-runner.mjs'
}
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "Relay runner not found: $runner" }
if (-not (Test-Path -LiteralPath $SecretPath -PathType Leaf)) { throw "Protected relay credentials not found: $SecretPath" }

$config = Get-Content -LiteralPath $SecretPath -Raw | ConvertFrom-Json
if ([int]$config.version -ne 1 -or [string]$config.credential_type -ne 'cloudflare_drive_relay') {
  throw 'Unsupported protected relay credential file format.'
}
$relayUrl = [string]$config.relay_url
$protectedRelayKey = [string]$config.relay_key_dpapi
if ([string]::IsNullOrWhiteSpace($relayUrl) -or [string]::IsNullOrWhiteSpace($protectedRelayKey)) {
  throw 'Protected relay credential file is incomplete.'
}
$relayUri = [Uri]$relayUrl
if ($relayUri.Scheme -ne 'wss' -or $relayUri.AbsolutePath -ne '/__relay/ws' -or $relayUri.Query -or $relayUri.Fragment) {
  throw 'Protected relay URL must be a fixed wss:// URL ending in /__relay/ws.'
}

$secureRelayKey = ConvertTo-SecureString -String $protectedRelayKey
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureRelayKey)
try {
  $relayKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if ([string]::IsNullOrWhiteSpace($relayKey) -or $relayKey.Length -lt 32) { throw 'DPAPI relay key is invalid.' }

$env:DRIVE_RELAY_URL = $relayUrl
$env:DRIVE_RELAY_KEY = $relayKey
$env:DRIVE_RELAY_LOCAL_ORIGIN = "http://127.0.0.1:$Port"
$env:DRIVE_RELAY_LOG_LEVEL = 'info'

$exitCode = 1
try {
  Set-Location -LiteralPath (Split-Path -Parent $runner)
  & $node $runner
  $exitCode = $LASTEXITCODE
} finally {
  $env:DRIVE_RELAY_KEY = $null
  $env:DRIVE_RELAY_URL = $null
  $env:DRIVE_RELAY_LOCAL_ORIGIN = $null
  $relayKey = $null
}
exit $exitCode
