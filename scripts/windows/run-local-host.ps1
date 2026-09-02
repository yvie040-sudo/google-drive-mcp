[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath,

  [Parameter(Mandatory = $true)]
  [string]$IssuerUrl,

  [Parameter(Mandatory = $true)]
  [string]$NodePath,

  [int]$Port = 3100,

  [string]$SecretPath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\hosted-secrets.json'),

  [string]$StorePath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\team-store.json'),

  [int]$TrustProxyHops = 1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Port -lt 1 -or $Port -gt 65535) {
  throw "Invalid port: $Port"
}
if ($TrustProxyHops -lt 0) {
  throw "Invalid TrustProxyHops: $TrustProxyHops"
}

$repo = (Resolve-Path -LiteralPath $RepoPath).Path
$node = (Resolve-Path -LiteralPath $NodePath).Path
$launcher = Join-Path $repo 'scripts\start-hosted.js'
$entrypoint = Join-Path $repo 'dist\index.js'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw "Hosted launcher not found: $launcher"
}
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
  throw "Built entrypoint not found: $entrypoint. Run npm run build first."
}
if (-not (Test-Path -LiteralPath $SecretPath -PathType Leaf)) {
  throw "Protected OAuth credential file not found: $SecretPath"
}

try {
  $issuer = [Uri]$IssuerUrl
} catch {
  throw "Invalid issuer URL: $IssuerUrl"
}
if ($issuer.Scheme -ne 'https') {
  throw 'IssuerUrl must use https.'
}
if ($issuer.AbsolutePath -ne '/' -or -not [string]::IsNullOrEmpty($issuer.Query) -or -not [string]::IsNullOrEmpty($issuer.Fragment)) {
  throw 'IssuerUrl must be a root origin without path, query string, or fragment.'
}

$secretConfig = Get-Content -LiteralPath $SecretPath -Raw | ConvertFrom-Json
if ([int]$secretConfig.version -ne 1 -or [string]$secretConfig.credential_type -ne 'google_oauth_web') {
  throw 'Unsupported protected OAuth credential file format.'
}
$clientId = [string]$secretConfig.client_id
$protectedSecret = [string]$secretConfig.client_secret_dpapi
if ([string]::IsNullOrWhiteSpace($clientId) -or [string]::IsNullOrWhiteSpace($protectedSecret)) {
  throw 'Protected OAuth credential file is incomplete.'
}

$secureSecret = ConvertTo-SecureString -String $protectedSecret
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
try {
  $clientSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$storeDirectory = Split-Path -Parent $StorePath
New-Item -ItemType Directory -Path $storeDirectory -Force | Out-Null

$env:GOOGLE_DRIVE_MCP_CLIENT_ID = $clientId
$env:GOOGLE_DRIVE_MCP_CLIENT_SECRET = $clientSecret
$env:MCP_TEAM_ISSUER_URL = $issuer.GetLeftPart([UriPartial]::Authority)
$env:MCP_HTTP_HOST = '127.0.0.1'
$env:MCP_HTTP_PORT = [string]$Port
$env:MCP_TEAM_STORE = 'file'
$env:MCP_TEAM_STORE_PATH = $StorePath
$env:MCP_TRUST_PROXY = [string]$TrustProxyHops
$env:MCP_HTTP_ALLOWED_HOSTS = "localhost,127.0.0.1,$($issuer.DnsSafeHost)"
$env:NODE_ENV = 'production'

$exitCode = 1
try {
  Set-Location -LiteralPath $repo
  & $node $launcher
  $exitCode = $LASTEXITCODE
} finally {
  $env:GOOGLE_DRIVE_MCP_CLIENT_SECRET = $null
  $clientSecret = $null
}

exit $exitCode
