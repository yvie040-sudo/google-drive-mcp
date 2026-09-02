# Drive compatibility notes

The OpenAI compatibility layer is audited against the live ChatGPT Google Drive connector surface available on 2026-09-02. The Google compatibility layer is audited against Google's first-party Drive MCP Developer Preview documentation available on the same date.

The fork keeps the exact 45 OpenAI tool names and the exact 8 Google first-party Drive MCP tool names while retaining every upstream endpoint. Because `copy_file`, `create_file`, and `get_file_metadata` exist in both provider contracts, those three names expose a union schema and dispatch by argument dialect instead of being registered twice.

Seventeen additional power endpoints cover modern Drive capabilities and optional Workspace governance features without changing either provider contract.

## Google first-party Drive MCP fallback

Google publishes a remote Drive MCP endpoint at `https://drivemcp.googleapis.com/mcp/v1` using Streamable HTTP and Google OAuth 2.0. The Google Drive API and Google Drive MCP API (`drivemcp.googleapis.com`) must be enabled in the OAuth project before this passthrough can work.

The passthrough is off by default. The eight Google-compatible tool names still use local handlers without it. Set `GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK=true` only after the Google Cloud project is configured. The server then tries the first-party provider with the active account's Google access token and falls back locally when the preview service is unavailable, unsupported for the account, unauthorized, or times out.

This is especially useful for `read_file_content`, because Google's first-party service documents richer rendering for PDF, Office/OpenDocument files, and images than the raw Drive API alone exposes.

Configuration:

- `GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK=true` enables provider fallback.
- `GOOGLE_DRIVE_FIRST_PARTY_MCP_URL` overrides the provider URL.
- `GOOGLE_DRIVE_FIRST_PARTY_MCP_TIMEOUT_MS` changes the 10-second fallback timeout (bounded to 1–120 seconds).

## Large downloads and exports

`files.export` has an export size limit. `export_file` fetches the export through the authenticated server and returns a standard MCP resource, so it never exposes a bare authenticated Google export URL. Use `download_file_lro` for the Drive v3 `files.download` long-running-operation flow when a native export is too large or when working with Google Vids. Use `get_download_operation` to resume polling without keeping one MCP request open indefinitely.

Both export and download paths preflight `capabilities.canDownload`. Google Drawings default to PNG, Apps Script projects default to the script JSON export, and Google Vids use MP4 through `files.download`.

OpenAI's hosted connector can return a proprietary user-scoped `file_uri`. A generic self-hosted MCP cannot mint that OpenAI-internal object, so the portable equivalent is standard MCP resource/resource-link content plus Drive `files.download` operations. This is an implementation difference, not a missing Drive operation.

## File parameters

The import, upload, update and raw batch-image tools advertise file parameters through tool `_meta["openai/fileParams"]`, matching the Apps/Codex file-parameter bridge. Provided-file objects containing `download_url`/`file_id` are materialized in a temporary directory, passed to the local handler, and cleaned up after the call. Batch image placeholders are rewritten before the Google API request.

## Extended Drive power pack

The extended pack adds:

- applied file labels: list and atomic modify
- Drive content approvals: list/get/start/approve/decline/reassign/cancel/comment
- Shared Drive get/create/update/delete/hide/unhide
- changes start-page-token and incremental changes list
- trash list and restore
- Drive Activity v2 query
- Drive Labels schema list/get/create/delta/publish/disable/enable/delete

Applied file labels, approvals, Shared Drive management, changes and trash operations use ordinary Drive scopes. Drive Activity and the Drive Labels schema API require extra scopes and are intentionally opt-in.

## OAuth scope policy

The default upstream scopes are unchanged. Optional aliases are available for:

- `drive.activity.readonly`, `drive.activity`
- `drive.labels.readonly`, `drive.labels`
- `drive.admin.labels.readonly`, `drive.admin.labels`

These aliases are not included in `DEFAULT_SCOPES`, preventing a parity-only deployment from unexpectedly broadening its Google consent screen.
