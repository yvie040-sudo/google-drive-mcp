# Windows local production hosting

This path runs the existing hosted/team-mode MCP on a Windows PC as a single persistent local process. It does **not** change the Google Drive tool surface or replace the existing official ChatGPT Google Drive connector.

## Architecture

```text
ChatGPT
  -> fixed public HTTPS issuer
  -> secure ingress / tunnel
  -> http://127.0.0.1:3100
  -> Nick Drive MCP hosted team mode
  -> Google OAuth as the signed-in MCP user
```

The MCP remains a single process because MCP sessions and in-flight OAuth authorization state are held in-process. Durable Google refresh grants are stored in the file-backed team store.

## Windows persistence

The scripts in `scripts/windows/` use a native Windows Scheduled Task instead of pretending that a normal Node process is a Windows Service Control Manager service.

The task:

- runs under the Windows user that owns the DPAPI-protected Google OAuth client secret;
- uses S4U so a plaintext Windows password is not embedded in the task;
- starts at boot and at logon;
- restarts after failure;
- runs the existing `scripts/start-hosted.js` launcher;
- binds the MCP only to `127.0.0.1`;
- keeps the team store and protected OAuth credentials outside the repository under `%LOCALAPPDATA%\NickDriveMcp` by default.

## 1. Google OAuth Web client

Hosted team mode requires a Google OAuth **Web application** client, not a Desktop client.

The public issuer must be known first. Register this redirect URI exactly:

```text
<issuer>/oauth/google/callback
```

Example shape only:

```text
https://drive-mcp.example.com/oauth/google/callback
```

Do not guess the final hostname. Google requires an exact redirect URI match.

Download the Web client JSON to Windows, then import it into DPAPI-protected local storage:

```powershell
.\scripts\windows\import-google-web-credentials.ps1 `
  -InputPath 'C:\path\to\downloaded-client.json' `
  -DeleteSource
```

The script stores the client ID plus a DPAPI-protected client secret at:

```text
%LOCALAPPDATA%\NickDriveMcp\hosted-secrets.json
```

The plaintext client secret is never written by the script to stdout.

## 2. Install the local runtime

Check out a commit that contains production baseline:

```text
49c06c4c36e1c0792c2af61b5bc435fe00935403
```

Then run from an elevated PowerShell session:

```powershell
.\scripts\windows\install-local-host.ps1 `
  -RepoPath 'C:\path\to\google-drive-mcp' `
  -IssuerUrl 'https://your-fixed-hostname.example' `
  -StartNow
```

The installer:

1. verifies Node.js 22 or newer;
2. proves the checkout contains the known production baseline;
3. refuses a dirty working tree unless `-AllowDirty` is explicit;
4. runs `npm ci` and `npm run build` unless `-SkipBuild` is explicit;
5. restricts the `%LOCALAPPDATA%\NickDriveMcp` runtime directory to the current Windows identity;
6. installs the `Nick Drive MCP` Scheduled Task;
7. optionally starts it immediately;
8. when `-StartNow` is used, requires the local `/mcp` endpoint to answer unauthenticated requests with HTTP 401 before reporting success.

The runtime wrapper sets these values only in the MCP process environment:

- `MCP_HTTP_HOST=127.0.0.1`
- `MCP_HTTP_PORT=3100` by default
- `MCP_TEAM_MODE=true` through the hosted launcher
- `MCP_TEAM_ISSUER_URL=<fixed HTTPS issuer>`
- `MCP_TEAM_STORE=file`
- `MCP_TEAM_STORE_PATH=%LOCALAPPDATA%\NickDriveMcp\team-store.json`
- `MCP_TRUST_PROXY=1`

The Google client secret is decrypted from DPAPI only inside the runtime process and is not passed on the Scheduled Task command line.

## 3. Public ingress

The public ingress must satisfy all of the following:

- one fixed HTTPS root origin;
- forwards to `http://127.0.0.1:3100`;
- preserves streaming HTTP/SSE behavior needed by Streamable HTTP MCP;
- preserves the OAuth routes at the origin root;
- does not expose port 3100 directly to the internet;
- has stable availability across restarts.

### Cloudflare safety rule

Do **not** blindly run `cloudflared service install` or overwrite `%USERPROFILE%\.cloudflared\config.yml` on a machine that already hosts other MCP tunnels. Inspect the existing Cloudflare service, tunnel IDs, routes and config first. Reuse or extend existing infrastructure where possible.

A Cloudflare Quick Tunnel is not a production issuer because its hostname is temporary. The final route needs a stable hostname suitable for the exact Google OAuth callback above.

If an existing Secure MCP Tunnel / Worker relay is already the canonical ingress for other local MCPs, verify whether it can proxy this MCP's full Streamable HTTP + OAuth surface before creating a separate named tunnel.

## 4. ChatGPT endpoint

Once ingress and Google OAuth are live, the MCP server URL is:

```text
<issuer>/mcp
```

The expected authorization flow is:

1. ChatGPT discovers the MCP OAuth metadata.
2. ChatGPT dynamically registers as an OAuth client where supported.
3. The MCP redirects the user through Google consent.
4. Google returns to `<issuer>/oauth/google/callback`.
5. The MCP issues its own OAuth tokens to the MCP client.
6. Drive operations execute as the Google account that completed consent.

For this deployment, the intended Google account is `nickzijlmans1@gmail.com`. The email address is not hardcoded in the repository.

## 5. Durable state

Default team-store path:

```text
%LOCALAPPDATA%\NickDriveMcp\team-store.json
```

This file contains Google refresh tokens and must be treated as a secret database. Do not sync it to Git or public cloud storage. Back it up only through a secret-safe method.

If the team store is lost, the Google account must authorize again. Losing in-flight authorization state during a restart only requires retrying that login flow.

## 6. Removal

Removing the persistent task does not delete credentials or OAuth grants by default:

```powershell
.\scripts\windows\remove-local-host.ps1 -Confirm:$false
```

To deliberately remove protected Google OAuth client credentials:

```powershell
.\scripts\windows\remove-local-host.ps1 `
  -RemoveProtectedCredentials `
  -Confirm:$false
```

To deliberately delete the team store as well:

```powershell
.\scripts\windows\remove-local-host.ps1 `
  -RemoveProtectedCredentials `
  -RemoveTeamStore `
  -Confirm:$false
```

Deleting the team store invalidates the persisted local grant state and forces reauthorization.

## Acceptance gate

Do not call this deployment complete until all of these are proven on the real PC and public issuer:

- Windows branch/scripts CI passes;
- local Scheduled Task starts after a restart;
- local `/mcp` returns 401 without bearer auth;
- public OAuth metadata resolves over HTTPS;
- public `/mcp` reaches the local process;
- Google accepts the exact callback URI;
- `nickzijlmans1@gmail.com` completes consent;
- ChatGPT completes MCP OAuth;
- `initialize` succeeds;
- `tools/list` returns the expected registry;
- at least one read-only Drive call succeeds through the custom MCP;
- process restart preserves the file-backed user grant;
- no client secret, Google refresh token, MCP access token or team-store content appears in Git, chat output or public logs.
