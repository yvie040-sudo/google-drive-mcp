# Deployment

Use stdio for local desktop clients. Use Streamable HTTP for hosted single-identity services, or team mode for a shared service where every caller authenticates separately.

## Hosted launcher

For public hosting, build the project and run `npm run start:hosted`. The launcher forces Streamable HTTP team mode, binds to `0.0.0.0`, uses `MCP_HTTP_PORT` or the platform `PORT`, and requires a public HTTPS issuer. On Replit it can derive the issuer from the first `REPLIT_DOMAINS` value and sets `MCP_TRUST_PROXY=1` only for a published Replit deployment.

Required Google Web OAuth secrets for hosted team mode:

- `GOOGLE_DRIVE_MCP_CLIENT_ID`
- `GOOGLE_DRIVE_MCP_CLIENT_SECRET`

Register `<issuer>/oauth/google/callback` as an authorized Google redirect URI. On generic hosts set `MCP_TEAM_ISSUER_URL=https://your-host.example`; on Replit the launcher can derive it automatically.

The team store contains Google refresh tokens. Keep a single server process and put `MCP_TEAM_STORE_PATH` on persistent storage. A memory store is for temporary testing only. On hosts with ephemeral filesystems, file-backed team state can be lost on redeploy/restart unless the path is backed by persistent storage.

## Docker Usage

### Prerequisites

1. **Authenticate locally first** - Docker containers cannot open browsers for OAuth:
   ```bash
   # Using npx
   npx -y @piotr-agier/google-drive-mcp auth

   # Or using local installation
   npm run auth
   ```

2. **Verify token location**:
   ```bash
   ls -la ~/.config/google-drive-mcp/tokens.json
   ```

### Building the Docker Image

1. **Build the project** (required before Docker build):
   ```bash
   npm install
   npm run build
   ```

2. **Build the Docker image**:
   ```bash
   docker build -t google-drive-mcp .
   ```

### Running the Docker Container

The `scripts/docker-mcp.sh` wrapper manages the container lifecycle — it creates, reuses, and replaces containers automatically. MCP clients invoke this script directly (see configuration below).

To verify the image works after a rebuild:

```bash
docker run --rm google-drive-mcp --help
```

### Docker Configuration for Claude Desktop

#### Option A: Reusable container (recommended)

Uses a wrapper script that keeps a single named container running and reuses it across client restarts — faster startup and no container churn:

```json
{
  "mcpServers": {
    "google-drive": {
      "command": "/path/to/google-drive-mcp/scripts/docker-mcp.sh",
      "env": {
        "GOOGLE_DRIVE_OAUTH_CREDENTIALS": "$HOME/gcp-oauth.keys.json",
        "GOOGLE_DRIVE_MCP_TOKEN_PATH": "$HOME/.config/google-drive-mcp/tokens.json"
      }
    }
  }
}
```

The script will:
- Create the container on first run
- Reuse the existing container on subsequent runs
- Automatically restart it if it was stopped
- Replace the container when the image has been rebuilt

**Note:** The container stays running in the background until explicitly stopped.
To stop it: `docker stop google-drive-mcp`

#### Option B: Fresh container each time

Creates and removes a new container on every client restart:

```json
{
  "mcpServers": {
    "google-drive": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "/path/to/gcp-oauth.keys.json:/config/gcp-oauth.keys.json:ro",
        "/Users/yourname/.config/google-drive-mcp/tokens.json:/config/tokens.json",
        "google-drive-mcp"
      ]
    }
  }
}
```

**Docker-specific notes:**
- Uses `-i` for interactive mode (required for MCP stdio communication)
- Uses `--rm` to automatically remove the container after exit
- No port mapping needed (MCP uses stdio, not HTTP)
- Environment variables are set in the Dockerfile

## Streamable HTTP Transport

By default the server uses stdio transport (for local MCP clients like Claude Desktop). You can also run it as an HTTP server using the Streamable HTTP transport, which enables remote/hosted deployments and shared gateways.

### Starting in HTTP mode

```bash
google-drive-mcp start --transport http --port 3100 --host 127.0.0.1
```

Or with environment variables:

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=3100 MCP_HTTP_HOST=127.0.0.1 google-drive-mcp start
```

CLI flags take priority over environment variables.

| CLI Flag | Env Var | Default | Description |
|----------|---------|---------|-------------|
| `--transport` | `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `--port` | `MCP_HTTP_PORT` | `3100` | HTTP listen port |
| `--host` | `MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind address |

The HTTP endpoint is `POST /mcp` for JSON-RPC requests, `GET /mcp` for SSE streaming, and `DELETE /mcp` to close a session. After the initial `initialize` request, all subsequent requests must include the `mcp-session-id` header returned in the initialize response.

When binding to `127.0.0.1` (default), DNS rebinding protection is automatically enabled. For remote deployments (`0.0.0.0`), prefer [Team Mode](#team-mode-multi-user-http-deployments), which authenticates every request with per-user OAuth; a single-identity remote deployment (service account or external token) must sit behind a reverse proxy with TLS and its own access control. **Without authentication and TLS, anyone who can reach the port gets full access to the configured Google Drive account.**

### MCP client configuration (HTTP)

```json
{
  "mcpServers": {
    "google-drive": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

## Team Mode (multi-user HTTP deployments)

The default HTTP transport serves one identity to every caller. Team mode turns the server into a shared, multi-user service: it becomes an [MCP-spec OAuth 2.1 authorization server](https://modelcontextprotocol.io/specification/draft/basic/authorization), each team member signs in with their own Google account, and **every tool call runs as the caller**. This is the mode to use when exposing the server to a remote MCP client that supports OAuth.

How it works (two-hop OAuth): the MCP client registers itself via Dynamic Client Registration and sends the user to this server's `/authorize`; the server forwards them to Google's consent screen; on return it stores the user's Google refresh token (keyed by their stable Google account id) and issues its own opaque bearer tokens to the MCP client. Every `/mcp` request must carry such a bearer, and the identity it proves is the identity all tools act as.

### Setup

1. **Create a "Web application" OAuth client** in [Google Cloud Console](https://console.cloud.google.com/) (APIs & Services → Credentials). Team mode cannot use a Desktop client — Google restricts those to loopback redirect URIs.
2. **Add the redirect URI** `https://<your-server>/oauth/google/callback` to the client (the exact URI is printed at startup).
3. **Provide the credentials** either as a `gcp-oauth.keys.json` with a `web` section, or via `GOOGLE_DRIVE_MCP_CLIENT_ID` / `GOOGLE_DRIVE_MCP_CLIENT_SECRET` (convenient with a secret manager).
4. **Start the server**:

```bash
google-drive-mcp start --transport http --host 0.0.0.0 --port 3100 \
  --team --issuer-url https://drive-mcp.example.com
```

Or use the hosted launcher after building:

```bash
MCP_TEAM_ISSUER_URL=https://drive-mcp.example.com npm run start:hosted
```

5. **Connect the MCP client** to `https://drive-mcp.example.com/mcp`. The user is sent through the Google consent screen on connect and acts as themselves afterwards.

### Team mode configuration

| Env Var | CLI Flag | Default | Description |
|---------|----------|---------|-------------|
| `MCP_TEAM_MODE` | `--team` | off | Enable team mode (requires `--transport http`) |
| `MCP_TEAM_ISSUER_URL` | `--issuer-url` | — | Public https URL of this server (required; http allowed only for localhost) |
| `MCP_TEAM_ALLOWED_DOMAINS` | — | any Google account | Comma-separated Workspace domains allowed to sign in. Enforced on Google's `hd` claim, so consumer Gmail accounts are rejected when set |
| `MCP_TEAM_ALLOWED_REDIRECT_URIS` | — | open | Allowlist for client-registration redirect URIs. Leave open unless you know the exact callback URI(s) your MCP client uses. |
| `MCP_TEAM_TOKEN_TTL` | — | `3600` | Access-token lifetime in seconds, 60–86400 (default: 3600) |
| `MCP_TEAM_STORE` | — | `file` | `file` or `memory`. The file store survives process restarts only when its backing filesystem is persistent |
| `MCP_TEAM_STORE_PATH` | — | `<config dir>/team-store.json` | Location of the persistent store |
| `MCP_TRUST_PROXY` | — | unset | Trusted proxy hop count (`1` for a single reverse proxy) |
| `MCP_HTTP_ALLOWED_HOSTS` | — | issuer hostname | Extra allowed `Host` header values |

Team mode is mutually exclusive with service-account and external-token modes, never reads or writes `tokens.json`, and disables `manage_accounts`, the per-tool `account` parameter, and the `gdrive:///` resources capability — identity always comes from the bearer token. Google scopes follow `GOOGLE_DRIVE_MCP_SCOPES` as usual; each user's tool access is additionally gated by the scopes they actually granted at their own consent screen.

### Security notes

- **`team-store.json` is the deployment's most sensitive file.** It holds every member's Google refresh token plus registered clients; MCP tokens are stored only as SHA-256 hashes. Protect the backing storage accordingly.
- **TLS is required.** Run behind an https-terminating reverse proxy and set the correct trusted proxy hop count.
- **Every authorization shows a Google consent screen** (`prompt=consent`). This is deliberate.
- **Single process assumption.** In-flight sign-ins and authorization codes live in memory, and the file store serializes writes per process. Use a single process/instance unless the store/session architecture is upgraded for distributed hosting.
- **Revocation**: a user can disconnect client-side, revoke the Google app, or an operator can delete the user's entry from the team store.
