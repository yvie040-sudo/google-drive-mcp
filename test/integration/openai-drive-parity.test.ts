import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleTool, toolDefinitions } from '../../src/tools/openai-drive-parity.js';
import { OPENAI_DRIVE_TOOL_NAMES, NICK_DRIVE_EXTRA_TOOL_NAMES } from '../../src/parity/openai-drive-contract.js';

function fakeContext() {
  const calls: Array<{ method: string; args: any }> = [];
  const record = (method: string, data: any = {}) => async (args: any) => { calls.push({ method, args }); return { data }; };
  const drive: any = {
    files: { get: record('files.get', { id: 'file-1', name: 'file', mimeType: 'text/plain', capabilities: { canDownload: true } }), list: record('files.list', { files: [] }), create: record('files.create', { id: 'new-1' }), copy: record('files.copy', { id: 'copy-1' }), update: record('files.update', { id: 'file-1' }), delete: record('files.delete'), export: record('files.export', 'hello'), generateIds: record('files.generateIds', { ids: ['id-1'] }), emptyTrash: record('files.emptyTrash') },
    comments: { list: record('comments.list', { comments: [] }), create: record('comments.create', { id: 'c1' }) }, replies: { create: record('replies.create', { id: 'r1' }) }, revisions: { list: record('revisions.list', { revisions: [] }), get: record('revisions.get', {}) }, drives: { list: record('drives.list', { drives: [] }) }, about: { get: record('about.get', { user: { emailAddress: 'nick@example.com' }, storageQuota: {} }) }, permissions: { create: record('permissions.create', { id: 'perm-1' }) },
  };
  const docs = { documents: { get: record('documents.get', { documentId: 'doc-1', body: { content: [] } }), batchUpdate: record('documents.batchUpdate', { replies: [] }) } };
  const sheets = { spreadsheets: { get: record('spreadsheets.get', { sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] }), create: record('spreadsheets.create', { spreadsheetId: 'sheet-new' }), batchUpdate: record('spreadsheets.batchUpdate', {}), sheets: { copyTo: record('spreadsheets.sheets.copyTo', { sheetId: 7 }) }, values: { get: record('spreadsheets.values.get', { values: [['h'], ['needle']] }) } } };
  const slides = { presentations: { get: record('presentations.get', { presentationId: 'pres-1', slides: [] }), batchUpdate: record('presentations.batchUpdate', {}), pages: { get: record('presentations.pages.get', {}), getThumbnail: record('presentations.pages.getThumbnail', { contentUrl: 'https://thumb', width: 320, height: 180 }) } } };
  const authClient = { request: async (args: any) => { calls.push({ method: `auth.${args.method || 'GET'}`, args }); return { data: args.url === 'https://thumb' ? Buffer.from('png') : { name: 'operations/op-1', done: false } }; } };
  const ctx: any = { authClient, google: { docs: () => docs, sheets: () => sheets, slides: () => slides }, getDrive: () => drive, log: () => {}, runtimeConfig: {}, resolvePath: async (v: string) => v, resolveFolderId: async (v: string) => v };
  return { ctx, calls };
}

describe('OpenAI Drive parity behavior', () => {
  it('contains every official non-search name plus four power tools', () => {
    const names = new Set(toolDefinitions.map((tool) => tool.name)); assert.equal(toolDefinitions.length, 48);
    for (const name of OPENAI_DRIVE_TOOL_NAMES) if (name !== 'search') assert.ok(names.has(name), name);
    for (const name of NICK_DRIVE_EXTRA_TOOL_NAMES) assert.ok(names.has(name), name);
  });
  it('normalizes a Docs URL and forwards raw batchUpdate requests', async () => {
    const { ctx, calls } = fakeContext(); const result = await handleTool('batch_update_document', { document_url: 'https://docs.google.com/document/d/doc-123/edit', requests: [{ insertText: { location: { index: 1 }, text: 'x' } }] }, ctx);
    assert.equal(result?.isError, false); const call = calls.find((entry) => entry.method === 'documents.batchUpdate'); assert.equal(call?.args.documentId, 'doc-123'); assert.equal(call?.args.requestBody.requests.length, 1);
  });
  it('preserves Sheets value_render_option', async () => {
    const { ctx, calls } = fakeContext(); const result = await handleTool('get_spreadsheet_range', { spreadsheet_id: 'sheet-1', range: 'A1:B2', value_render_option: 'FORMULA' }, ctx); assert.equal(result?.isError, false); assert.equal(calls.find((entry) => entry.method === 'spreadsheets.values.get')?.args.valueRenderOption, 'FORMULA');
  });
  it('adds human-readable location context to unanchored comments', async () => {
    const { ctx, calls } = fakeContext(); const result = await handleTool('bulk_update_file_comments', { id: 'file-1', comments: [{ content: 'Check this', quoted_text: 'Total', sheet_cell_range: 'Sheet1!B2' }] }, ctx); assert.equal(result?.isError, false); const content = calls.find((entry) => entry.method === 'comments.create')?.args.requestBody.content; assert.match(content, /quote=/); assert.match(content, /Sheet1!B2/);
  });
  it('starts files.download only after canDownload preflight', async () => {
    const { ctx, calls } = fakeContext(); const result = await handleTool('download_file_lro', { file_id: 'file-1' }, ctx); assert.equal(result?.isError, false); assert.ok(calls.find((entry) => entry.method === 'files.get')); assert.match(calls.find((entry) => entry.method === 'auth.POST')?.args.url || '', /\/files\/file-1\/download$/);
  });
  it('guards empty_trash with explicit confirmation', async () => {
    const first = fakeContext(); const denied = await handleTool('empty_trash', { confirm: false }, first.ctx); assert.equal(denied?.isError, true); assert.equal(first.calls.some((entry) => entry.method === 'files.emptyTrash'), false);
    const second = fakeContext(); const allowed = await handleTool('empty_trash', { confirm: true }, second.ctx); assert.equal(allowed?.isError, false); assert.equal(second.calls.some((entry) => entry.method === 'files.emptyTrash'), true);
  });
  it('supports pre-generated Drive IDs', async () => {
    const { ctx, calls } = fakeContext(); const result = await handleTool('generate_drive_ids', { count: 3 }, ctx); assert.equal(result?.isError, false); assert.equal(calls.find((entry) => entry.method === 'files.generateIds')?.args.count, 3);
  });
});
