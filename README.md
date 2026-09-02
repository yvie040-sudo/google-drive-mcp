# Nick Drive MCP

A self-hosted Google Drive, Docs, Sheets and Slides MCP fork based on `piotr-agier/google-drive-mcp` v2.6.0.

This fork exposes **182 MCP tools**. It preserves the full upstream toolset, adds the exact current 45-name OpenAI Google Drive compatibility surface, adds the current 8-name Google first-party Drive MCP surface, and adds 17 modern/extended Drive power endpoints.

## What this fork adds

- Exact OpenAI Drive tool names such as `fetch`, `update_file`, `upload_file`, `batch_update_document`, `get_spreadsheet_cells`, and `create_presentation_from_template`.
- Compatibility with Google’s current first-party Drive MCP tool names: `copy_file`, `create_file`, `download_file_content`, `get_file_metadata`, `get_file_permissions`, `list_recent_files`, `read_file_content`, and `search_files`.
- The three overlapping OpenAI/Google names (`copy_file`, `create_file`, `get_file_metadata`) accept both provider dialects without duplicate tool registration.
- Optional provider-accurate fallback to Google’s Developer Preview Drive MCP at `https://drivemcp.googleapis.com/mcp/v1`. It reuses the active Google OAuth token and falls back to the local implementation if the preview service is unavailable. Set `GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK=false` to disable it or `GOOGLE_DRIVE_FIRST_PARTY_MCP_URL` to override the endpoint.
- Raw Docs, Sheets and Slides `batchUpdate` passthrough with optional file-backed image sidecars.
- Permanent deletion, revision content reads, generic file comments, profile/metadata reads, structured Docs/Sheets/Slides inspection, native Office imports, and Drive sharing helpers.
- OpenAI Apps/Codex file parameter metadata through `_meta["openai/fileParams"]`, including provider-file materialization and cleanup.
- `search` compatibility fields including cursor pagination, provider filters, item-type filters and optional best-effort text hydration.
- `download_file_lro` and `get_download_operation` for Drive v3 `files.download`, including Google Vids and large native exports beyond the `files.export` size limit.
- `generate_drive_ids` for advanced transactional creation flows.
- `empty_trash` guarded by `confirm=true`.
- Applied file label listing/modification, Drive approvals, Shared Drive administration, Drive changes/delta sync, trash listing/restore.
- Optional Drive Activity and Drive Labels schema tools. Their extra OAuth scopes are available as aliases but are deliberately not added to the default consent grant.
- Cross-platform test execution so `npm test` works on Windows as well as Linux/macOS. The POSIX `0600` file-mode assertion is skipped only on Windows, where that mode is not representable.

## Documentation

- [Tool reference](docs/tools.md)
- [OpenAI Drive parity notes](docs/openai-drive-parity.md)
- [Setup](docs/setup.md)
- [Client configuration](docs/clients.md)
- [Authentication](docs/authentication.md)
- [Deployment](docs/deployment.md)
- [Configuration](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)

## Optional power-pack scopes

Ordinary Drive parity continues to use the upstream default scopes. To use Drive Activity or the Drive Labels schema API, explicitly include the relevant scope aliases in `GOOGLE_DRIVE_MCP_SCOPES` together with any ordinary scopes you still need:

- `drive.activity.readonly` or `drive.activity`
- `drive.labels.readonly` or `drive.labels`
- `drive.admin.labels.readonly` or `drive.admin.labels`

Applied labels on files (`list_file_labels`, `modify_file_labels`) and Drive Approvals use normal Drive scopes and do not require this extra consent.

## Google first-party fallback

Google’s own remote Drive MCP is currently a Developer Preview. Nick Drive uses it only for the Google-MCP compatibility dialect and only when reachable. Normal upstream and OpenAI-compatible tools remain locally implemented. This makes Google’s richer file rendering, including formats such as PDF, Office files and images, available without turning the entire self-hosted server into a proxy dependency.

The fallback timeout defaults to 20 seconds and can be changed with `GOOGLE_DRIVE_FIRST_PARTY_MCP_TIMEOUT_MS` (1,000–120,000 ms). A connection/auth/preview failure is logged and the local implementation is used instead.

## Safety notes

`delete_file`, `empty_trash`, Shared Drive deletion, approval actions, and label-schema mutations can be destructive or externally visible. `empty_trash` refuses to run unless `confirm=true`. Shared Drive item deletion requires domain-admin mode. Google Sheets image sidecars can remain in Drive when a formula keeps referencing their URL; the tool reports those retained files explicitly.

The current OpenAI and Google Drive MCP compatibility contracts are frozen in `src/parity/openai-drive-contract.ts` and checked in tests so a future upstream merge cannot silently remove a provider route.

## License

MIT, following the upstream project license.
