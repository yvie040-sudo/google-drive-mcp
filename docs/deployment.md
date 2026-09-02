# Deployment

Use stdio for local desktop clients. Use Streamable HTTP for hosted single-identity services, or team mode for a shared service where every caller authenticates separately.

## Hosted launcher

For public hosting, build the project and run `npm run start:hosted`. The launcher forces Streamable HTTP team mode, binds to `0.0.0.0`, uses `MCP_HTTP_PORT` or the platform `PORT`, and requires a public HTTPS issuer. On Replit it can derive the issuer from the first `REPLIT_DOMAINS` value and sets `MCP_TRUST_PROXY=1` only for a published Replit deployment.

Required Google Web OAuth secrets for hosted team mode:

- `GOOGLE_DRIVE_MCP_CLIENT_ID`
- `GOOGLE_DRIVE_MCP_CLIENT_SECRET`

Register `<issuer>/oauth/google/callback` as an authorized Google redirect URI. On generic hosts set `MCP_TEAM_ISSUER_URL=https://your-host.example`; on Replit the launcher can derive it automatically.

The team store contains Google refresh tokens. Keep a single server process and put `MCP_TEAM_STORE_PATH` on persistent storage. A memory store is for temporary testing only. On hosts with ephemeral filesystems, file-backed team state can be lost on redeploy/restart unless the path is backed by persistent storage.

### Host suitability

This implementation maintains MCP sessions and OAuth authorization state in-process and persists Google refresh tokens in its team store. Prefer a single-process/container host with durable storage, or expose a locally authenticated instance through a secure MCP tunnel. Do not treat a stateless/autoscaling serverless deployment as production-equivalent unless the session and team stores are first moved to a distributed durable backend.

## Docker Usage

### Prerequisites

1. **Authenticate locally first** - Docker containers cannot open browsers for OAuth:
   ```bash
   npx -y @piotr-agier/google-drive-mcp auth
   # Or using local installation
   npm run auth
   ```

2. **Verify token location**:
   ```bash
   ls -la ~/.config/google-drive-mcp/tokens.json
   ```

### Building the Docker Image

```bash
npm install
npm run build
docker build -t google-drive-mcp .
```

To verify the image works after a rebuild:

```bash
docker run --rm google-drive-mcp --help
```

### Docker Configuration for Claude Desktop

A reusable local container can mount the OAuth credentials and token store and communicate over stdio. For a remote container, use Streamable HTTP team mode and durable storage instead of exposing a single-identity unauthenticated HTTP port.

## Streamable HTTP Transport

By default the server uses stdio transport. HTTP mode is available for remote/hosted deployments and gateways:

```bash
google-drive-mcp start --transport http --port 3100 --host 127.0.0.1
```

or:

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=3100 MCP_HTTP_HOST=127.0.0.1 google-drive-mcp start
```

The HTTP endpoint is `POST /mcp` for JSON-RPC requests, `GET /mcp` for SSE streaming, and `DELETE /mcp` to close a session. After `initialize`, subsequent requests carry the `mcp-session-id` header.

When binding to `127.0.0.1`, DNS-rebinding protection is enabled. For a public `0.0.0.0` deployment, use team mode or put a single-identity deployment behind TLS plus access control. **Never expose an unauthenticated single-identity instance directly to the internet.**

## Team Mode (multi-user HTTP deployments)

Team mode is an MCP-spec OAuth 2.1 authorization server. Each caller signs in with Google and every Drive operation runs as that caller.

### Setup

1. Create a Google OAuth **Web application** client.
2. Register `https://<your-server>/oauth/google/callback`.
3. Set `GOOGLE_DRIVE_MCP_CLIENT_ID` and `GOOGLE_DRIVE_MCP_CLIENT_SECRET`, or provide a compatible web credentials JSON file.
4. Start with:

```bash
google-drive-mcp start --transport http --host 0.0.0.0 --port 3100 \
  --team --issuer-url https://drive-mcp.example.com
```

or after building:

```bash
MCP_TEAM_ISSUER_URL=https://drive-mcp.example.com npm run start:hosted
```

5. Connect the MCP client to `https://drive-mcp.example.com/mcp`.

### Team mode configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `MCP_TEAM_MODE` | off | Enable team mode |
| `MCP_TEAM_ISSUER_URL` | — | Public HTTPS issuer URL |
| `MCP_TEAM_ALLOWED_DOMAINS` | any Google account | Optional Workspace-domain allowlist |
| `MCP_TEAM_ALLOWED_REDIRECT_URIS` | open | Optional MCP-client redirect URI allowlist |
| `MCP_TEAM_TOKEN_TTL` | `3600` | Access-token lifetime |
| `MCP_TEAM_STORE` | `file` | `file` or `memory` |
| `MCP_TEAM_STORE_PATH` | config-dir `team-store.json` | Persistent team-state path |
| `MCP_TRUST_PROXY` | unset | Trusted reverse-proxy hop count |
| `MCP_HTTP_ALLOWED_HOSTS` | issuer hostname | Extra Host-header allowlist |

### Security notes

- `team-store.json` contains Google refresh tokens. Protect it as a secret database.
- TLS is required for a public issuer.
- Every authorization deliberately shows Google consent.
- The current design assumes one server process for in-flight sign-ins/session ownership.
- Revocation can happen client-side, at Google Account Permissions, or by removing the user's team-store entry.
