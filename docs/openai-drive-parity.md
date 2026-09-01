# OpenAI Drive parity notes

The compatibility layer is audited against the live Google Drive connector surface available on 2026-09-01.

The fork keeps the exact 45 official tool names and retains every upstream endpoint. Seventeen additional power endpoints cover modern Drive capabilities and optional Workspace governance features without changing the 45-name compatibility contract.

## Large downloads and exports

`files.export` has an export size limit. Use `download_file_lro` for the Drive v3 `files.download` long-running-operation flow when a native export is too large or when working with Google Vids. Use `get_download_operation` to resume polling without keeping one MCP request open indefinitely.

Both the export and download paths preflight `capabilities.canDownload`. Google Drawings default to PNG, Apps Script projects default to the script JSON export, and Google Vids use MP4 through `files.download`.

The standard custom-MCP equivalent of OpenAI's proprietary user-scoped `file_uri` store is an MCP `resource_link`. The fork uses standard resource links for streamed/downloadable results and embedded `resource` blocks when inline bytes are explicitly requested.

## File parameters

The import, upload, update and raw batch-image tools advertise file parameters through tool `_meta["openai/fileParams"]`, matching the Apps/Codex file-parameter bridge. The runtime can therefore resolve conversation/generated files to server-local file references before the handler runs.

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
