[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath,

  [string]$WorkerName = 'nick-drive-mcp',

  [string]$SecretPath = (Join-Path $env:LOCALAPPDATA 'NickDriveMcp\relay-secrets.json'),

  [switch]$RotateSecret
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path -LiteralPath $RepoPath).Path
$relayDir = Join-Path $repo 'infra\cloudflare-relay'
$configPath = Join-Path $relayDir 'wrangler.jsonc'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "Cloudflare relay config not found: $configPath"
}

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$npx = (Get-Command npx.cmd -ErrorAction Stop).Source

function New-RelayKey {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Unprotect-RelayKey {
  param([Parameter(Mandatory = $true)][string]$ProtectedValue)
  $secure = ConvertTo-SecureString -String $ProtectedValue
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

$relayKey = $null
if ((Test-Path -LiteralPath $SecretPath -PathType Leaf) -and -not $RotateSecret) {
  $existing = Get-Content -LiteralPath $SecretPath -Raw | ConvertFrom-Json
  if ([int]$existing.version -ne 1 -or [string]$existing.credential_type -ne 'cloudflare_drive_relay') {
    throw 'Existing relay secret file has an unsupported format. Use -RotateSecret only after reviewing the file.'
  }
  $relayKey = Unprotect-RelayKey -ProtectedValue ([string]$existing.relay_key_dpapi)
}
if ([string]::IsNullOrWhiteSpace($relayKey)) {
  $relayKey = New-RelayKey
}
if ($relayKey.Length -lt 32) {
  throw 'Relay key generation/decryption produced an invalid value.'
}

Push-Location $relayDir
try {
  & $npm ci
  if ($LASTEXITCODE -ne 0) { throw "Relay npm ci failed with exit code $LASTEXITCODE." }

  $deployOutput = @(& $npx wrangler deploy --config $configPath --name $WorkerName 2>&1 | ForEach-Object { [string]$_ })
  if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare relay deployment failed.`n$($deployOutput -join [Environment]::NewLine)"
  }
  $deployText = $deployOutput -join "`n"
  $urlMatch = [regex]::Match($deployText, 'https://[a-zA-Z0-9.-]+\.workers\.dev')
  if (-not $urlMatch.Success) {
    throw 'Wrangler deployed the Worker but no workers.dev URL could be verified from its output.'
  }
  $issuer = $urlMatch.Value.TrimEnd('/')

  $relayKey | & $npx wrangler secret put DRIVE_RELAY_KEY --config $configPath --name $WorkerName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Wrangler secret put failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

$secureRelayKey = ConvertTo-SecureString -String $relayKey -AsPlainText -Force
$protectedRelayKey = ConvertFrom-SecureString -SecureString $secureRelayKey
$roundTrip = Unprotect-RelayKey -ProtectedValue $protectedRelayKey
if ($roundTrip -cne $relayKey) {
  throw 'DPAPI round-trip verification failed for the relay key.'
}
$roundTrip = $null

$issuerUri = [Uri]$issuer
$relayUrl = "wss://$($issuerUri.Authority)/__relay/ws"
$secretDirectory = Split-Path -Parent $SecretPath
New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
$payload = [ordered]@{
  version = 1
  credential_type = 'cloudflare_drive_relay'
  worker_name = $WorkerName
  issuer_url = $issuer
  relay_url = $relayUrl
  relay_key_dpapi = $protectedRelayKey
  updated_utc = [DateTime]::UtcNow.ToString('o')
}
$tempPath = "$SecretPath.tmp.$PID"
$payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $tempPath -Encoding UTF8
Move-Item -LiteralPath $tempPath -Destination $SecretPath -Force

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $identity,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $SecretPath -AclObject $acl

$relayKey = $null
$healthUrl = "$issuer/__relay/health"
$healthStatus = $null
$healthError = $null
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  try {
    $health = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
    $healthStatus = [int]$health.StatusCode
    $healthError = $null
  } catch {
    if ($_.Exception.Response) {
      $healthStatus = [int]$_.Exception.Response.StatusCode
      $healthError = $null
    } else {
      $healthStatus = $null
      $healthError = $_.Exception.Message
    }
  }
  if ($healthStatus -eq 200 -or $healthStatus -eq 503) { break }
  Start-Sleep -Milliseconds 500
}
if ($healthStatus -ne 200 -and $healthStatus -ne 503) {
  if ($healthError) { throw "Deployed relay health endpoint is unreachable: $healthError" }
  throw "Deployed relay health endpoint returned unexpected HTTP $healthStatus after propagation retries."
}

Write-Output "Cloudflare relay deployed: $issuer"
Write-Output "Protected relay credentials stored at: $SecretPath"
Write-Output "Google callback to register exactly: $issuer/oauth/google/callback"
Write-Output "ChatGPT MCP endpoint: $issuer/mcp"
Write-Output 'The relay key was not printed and is DPAPI-bound to the current Windows user.'
