import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { handleTool, toolDefinitions } from '../../src/tools/google-drive-remote-compat.js';

function fakeContext() {
  const calls: Array<{ method: string; args: any }> = [];
  const record = (method: string, data: any) => async (args: any) => { calls.push({ method, args }); return { data }; };
  const drive: any = {
    files: {
      get: async (args: any, options?: any) => {
        calls.push({ method: 'files.get', args });
        if (args.alt === 'media') return { data: options?.responseType === 'arraybuffer' ? Buffer.from('binary') : 'plain text' };
        return { data: { id: args.fileId, name: 'Example', mimeType: 'application/vnd.google-apps.document', parents: ['root'], capabilities: { canDownload: true, canAddChildren: false } } };
      },
      list: record('files.list', { files: [{ id: 'f1', name: 'Alpha', mimeType: 'text/plain', modifiedTime: '2026-09-01T00:00:00Z', capabilities: { canDownload: true } }], nextPageToken: 'next' }),
      export: record('files.export', 'hello from doc'),
    },
    permissions: { list: record('permissions.list', { permissions: [{ role: 'reader', type: 'user', emailAddress: 'reader@example.com' }] }) },
    comments: { list: record('comments.list', { comments: [] }) },
  };
  const ctx: any = { getDrive: () => drive, log: () => {}, authClient: { credentials: {} } };
  return { ctx, calls };
}

let previousFallback: string | undefined;

describe('Google first-party Drive MCP compatibility', () => {
  before(() => { previousFallback = process.env.GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK; process.env.GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK = 'false'; });
  after(() => { if (previousFallback === undefined) delete process.env.GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK; else process.env.GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK = previousFallback; });

  it('registers the five names unique to the Google first-party surface', () => {
    assert.deepEqual(toolDefinitions.map((tool) => tool.name).sort(), ['download_file_content','get_file_permissions','list_recent_files','read_file_content','search_files'].sort());
  });

  it('translates Google structured search fields to Drive v3', async () => {
    const { ctx, calls } = fakeContext();
    const result = await handleTool('search_files', { query: "title contains 'Alpha'", pageSize: 7, excludeContentSnippets: true }, ctx);
    assert.equal(result?.isError, false);
    const list = calls.find((call) => call.method === 'files.list');
    assert.match(list?.args.q || '', /name contains 'Alpha'/);
    assert.equal(list?.args.pageSize, 7);
  });

  it('returns readable native file content locally when provider fallback is disabled', async () => {
    const { ctx, calls } = fakeContext();
    const result = await handleTool('read_file_content', { fileId: 'doc-1', includeComments: false }, ctx);
    assert.equal(result?.isError, false);
    const payload = JSON.parse((result?.content?.[0] as any).text);
    assert.equal(payload.fileContent, 'hello from doc');
    assert.ok(calls.some((call) => call.method === 'files.export'));
  });

  it('lists permissions with the Google first-party response envelope', async () => {
    const { ctx } = fakeContext();
    const result = await handleTool('get_file_permissions', { fileId: 'f1' }, ctx);
    const payload = JSON.parse((result?.content?.[0] as any).text);
    assert.equal(payload.permissions[0].role, 'reader');
  });
});
