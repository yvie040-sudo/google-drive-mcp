# Nick Drive MCP

A self-hosted Google Drive, Docs, Sheets and Slides MCP fork based on `piotr-agier/google-drive-mcp` v2.6.0.

This fork exposes **195 MCP tools**. It preserves the full upstream toolset, adds the exact current 45-name OpenAI Google Drive compatibility surface, adds the current 8-name Google first-party Drive MCP surface, and completes the practical non-deprecated Google Drive v3 REST resource surface with explicit power endpoints.

## What this fork adds

- Exact OpenAI Drive tool names such as `fetch`, `update_file`, `upload_file`, `batch_update_document`, `get_spreadsheet_cells`, and `create_presentation_from_template`.
- Compatibility with Google’s current first-party Drive MCP names: `copy_file`, `create_file`, `download_file_content`, `get_file_metadata`, `get_file_permissions`, `list_recent_files`, `read_file_content`, and `search_files`.
- The three overlapping OpenAI/Google names (`copy_file`, `create_file`, `get_file_metadata`) accept both provider dialects without duplicate registration.
- Complete practical coverage of current non-deprecated Drive v3 REST resources: about, access proposals, approvals, apps, changes, channels, comments, drives, files, operations, permissions, replies, and revisions.
- Raw Docs, Sheets and Slides `batchUpdate` passthrough with optional file-backed image sidecars.
- Permanent deletion, revision content reads/mutation, generic comment/reply CRUD, permission lookup, access-proposal resolution, profile/metadata reads, native Office imports, Drive sharing, labels, approvals, Shared Drive administration, changes/delta sync, trash restore and CSE token generation.
- Google Drive push-channel registration for files or the changes feed plus explicit channel shutdown. Webhook registration refuses non-HTTPS callback addresses.
- OpenAI Apps/Codex file parameter metadata through `_meta["openai/fileParams"]`, including provider-file materialization and cleanup.
- Authenticated MCP resource output for exports. Large native downloads use Drive `files.download` long-running operations.
- Optional Drive Activity and Drive Labels schema operations. Their extra OAuth scopes are aliases only and are deliberately not added to the default consent grant.
- Cross-platform test execution so `npm test` works on Windows as well as Linux/macOS. The POSIX `0600` file-mode assertion is skipped only on Windows, where that mode is not representable.
- `npm run start:hosted` for production-style team-mode hosting. It binds externally, consumes the platform `PORT`, derives the issuer from `REPLIT_DOMAINS` when present, and sets one trusted proxy hop only on Replit deployments. It refuses to start without a trustworthy public issuer.

## Hosted team mode

Build first, then run `npm run start:hosted`. Hosted mode requires a Google OAuth **Web application** client:

- `GOOGLE_DRIVE_MCP_CLIENT_ID`
- `GOOGLE_DRIVE_MCP_CLIENT_SECRET`

Set `MCP_TEAM_ISSUER_URL` explicitly on generic hosts. On Replit, the launcher can derive it from the first `REPLIT_DOMAINS` entry. Register `<issuer>/oauth/google/callback` as an authorized Google redirect URI.

The team store contains Google refresh tokens. Use a single process and persistent storage for `MCP_TEAM_STORE_PATH`. A memory store is suitable only for temporary testing because users must re-consent after a restart.

A local authenticated deployment exposed through a secure MCP tunnel is also a first-class production option. It avoids copying Google refresh tokens to a third-party host and fits the server's single-process/session architecture well.

## Documentation

- [Tool reference](docs/tools.md)
- [Drive compatibility notes](docs/openai-drive-parity.md)
- [Setup](docs/setup.md)
- [Client configuration](docs/clients.md)
- [Authentication](docs/authentication.md)
- [Deployment](docs/deployment.md)
- [Configuration](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)

## Optional scopes

Ordinary OpenAI parity, Google-MCP compatibility, access proposals, approvals, changes, comments, permissions, revisions, watches and most Drive-v3 completion routes use the existing Drive scopes.

Extra aliases are available through `GOOGLE_DRIVE_MCP_SCOPES` when needed:

- `drive.apps.readonly` for listing installed/authorized Drive apps
- `drive.activity.readonly` or `drive.activity`
- `drive.labels.readonly` or `drive.labels`
- `drive.admin.labels.readonly` or `drive.admin.labels`

These are not added to `DEFAULT_SCOPES`.

## Google first-party fallback

Google’s remote Drive MCP is a Developer Preview and requires both `drive.googleapis.com` and `drivemcp.googleapis.com` to be enabled in the OAuth project. The passthrough is **off by default**. Google-compatible names still work through local handlers without it.

To enable provider-accurate fallback after configuring the Google Cloud project, set `GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK=true`. You can override the endpoint with `GOOGLE_DRIVE_FIRST_PARTY_MCP_URL`. The timeout defaults to 10 seconds and can be changed with `GOOGLE_DRIVE_FIRST_PARTY_MCP_TIMEOUT_MS`.

## Safety notes

`delete_file`, `empty_trash`, Shared Drive deletion, access-proposal resolution, approval actions, permission changes, revision deletion, label-schema mutations, CSE operations and webhook registration can be destructive or externally visible. `empty_trash` refuses to run unless `confirm=true`. Watch registration requires an explicit HTTPS callback address; Nick Drive never invents or auto-publishes one.

The current OpenAI, Google Drive MCP, and Drive-v3 completion contracts are frozen in `src/parity/openai-drive-contract.ts` and checked in tests so future upstream merges cannot silently remove a route.

## License

MIT, following the upstream project license.
