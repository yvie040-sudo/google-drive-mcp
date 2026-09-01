# OpenAI Drive parity notes

The compatibility layer is audited against the live Google Drive connector surface available on 2026-09-01.

The fork keeps the exact 45 official tool names and retains every upstream endpoint. Four additional power endpoints cover current Drive API capabilities that are useful for a self-hosted fallback but are not part of that 45-name compatibility contract.

## Large downloads

`files.export` remains subject to Google's export size limit. Use `download_file_lro` for the Drive v3 `files.download` long-running-operation flow when a native export is too large or when working with Google Vids. Use `get_download_operation` to resume polling without keeping one MCP request open indefinitely.

Both paths preflight `capabilities.canDownload` before starting a download.

## File parameters

The import, upload, update and raw batch-image tools advertise file parameters so ChatGPT-compatible MCP runtimes can resolve user/generated files to server-local file references before the handler runs.

## Scope-expanding APIs intentionally not enabled by default

Drive Activity, Drive Labels and Approvals are valuable extensions, but they introduce additional Google APIs and OAuth scopes. They are not silently added to the default authorization grant. They should be introduced as a separately gated capability pack if needed, so existing users are not forced into broader consent merely to obtain Drive parity.
