# Nick Drive MCP

A self-hosted Google Drive, Docs, Sheets and Slides MCP fork based on `piotr-agier/google-drive-mcp` v2.6.0.

This fork exposes **164 MCP tools**. It preserves the full upstream toolset, adds the exact current 45-name OpenAI Google Drive compatibility surface, and adds four advanced Drive operations for large downloads and destructive/admin workflows.

## What this fork adds

- Exact official tool names such as `fetch`, `update_file`, `upload_file`, `batch_update_document`, `get_spreadsheet_cells`, and `create_presentation_from_template`.
- Raw Docs, Sheets and Slides `batchUpdate` passthrough with optional file-backed image sidecars.
- Permanent deletion, revision content reads, generic file comments, profile/metadata reads, structured Docs/Sheets/Slides inspection, native Office imports, and Drive sharing helpers.
- OpenAI-style file parameter declarations for upload/import/update tools.
- `search` compatibility fields including cursor pagination, provider filters, item-type filters and optional best-effort text hydration.
- `download_file_lro` and `get_download_operation` for the modern Drive `files.download` long-running-operation flow, including Google Vids and large native exports.
- `generate_drive_ids` for advanced transactional creation flows.
- `empty_trash` guarded by `confirm=true`.
- Cross-platform test execution so `npm test` works on Windows as well as Linux/macOS. The POSIX `0600` file-mode assertion is skipped only on Windows, where that mode is not representable.

## Documentation

- [Tool reference](docs/tools.md)
- [Setup](docs/setup.md)
- [Client configuration](docs/clients.md)
- [Authentication](docs/authentication.md)
- [Deployment](docs/deployment.md)
- [Configuration](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)

## Safety notes

`delete_file` and `empty_trash` are permanent operations. `empty_trash` refuses to run unless `confirm=true` is supplied. Google Sheets image sidecars can remain in Drive when a formula keeps referencing their URL; the tool reports those retained files explicitly.

The OpenAI compatibility contract is frozen in `src/parity/openai-drive-contract.ts` and checked in CI so a future upstream merge cannot silently remove an official route.

## License

MIT, following the upstream project license.
