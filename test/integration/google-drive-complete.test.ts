import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleTool, toolDefinitions } from '../../src/tools/google-drive-complete.js';

function fakeContext() {
  const calls: Array<{ method: string; url: string; params?: any; data?: any }> = [];
  const ctx: any = {
    authClient: {
      request: async (args: any) => {
        calls.push({ method: args.method, url: args.url, params: args.params, data: args.data });
        return { data: { ok: true, url: args.url, ...(args.method === 'GET' && args.url.includes('/apps') ? { items: [] } : {}) } };
      },
    },
    log: () => {},
  };
  return { ctx, calls };
}

describe('Drive v3 completion pack', () => {
  it('registers exactly the thirteen completion tools', () => {
    assert.equal(toolDefinitions.length, 13);
    assert.deepEqual(new Set(toolDefinitions.map((tool) => tool.name)).size, 13);
  });

  it('requires roles when accepting an access proposal', async () => {
    const { ctx, calls } = fakeContext();
    const result = await handleTool('resolve_access_proposal', { file_id: 'f1', proposal_id: 'p1', action: 'ACCEPT' }, ctx);
    assert.equal(result?.isError, true);
    assert.equal(calls.length, 0);
  });

  it('routes access proposal resolution to the current v3 endpoint', async () => {
    const { ctx, calls } = fakeContext();
    const result = await handleTool('resolve_access_proposal', { file_id: 'f1', proposal_id: 'p1', action: 'ACCEPT', roles: ['reader'] }, ctx);
    assert.equal(result?.isError, false);
    assert.match(calls[0].url, /\/files\/f1\/accessproposals\/p1:resolve$/);
    assert.equal(calls[0].data.action, 'ACCEPT');
  });

  it('rejects non-HTTPS webhook addresses before registering a channel', async () => {
    const { ctx, calls } = fakeContext();
    const result = await handleTool('watch_drive_resource', { resource_type: 'file', file_id: 'f1', address: 'http://example.com/hook' }, ctx);
    assert.equal(result?.isError, true);
    assert.equal(calls.length, 0);
  });

  it('requires a page token for changes watches', async () => {
    const { ctx, calls } = fakeContext();
    const result = await handleTool('watch_drive_resource', { resource_type: 'changes', address: 'https://example.com/hook' }, ctx);
    assert.equal(result?.isError, true);
    assert.equal(calls.length, 0);
  });

  it('registers a file watch with a generated channel id', async () => {
    const { ctx, calls } = fakeContext();
    const result = await handleTool('watch_drive_resource', { resource_type: 'file', file_id: 'f1', address: 'https://example.com/hook' }, ctx);
    assert.equal(result?.isError, false);
    assert.match(calls[0].url, /\/files\/f1\/watch$/);
    assert.equal(calls[0].data.type, 'web_hook');
    assert.ok(typeof calls[0].data.id === 'string' && calls[0].data.id.length > 10);
  });

  it('enforces mutually exclusive CSE file and parent inputs', async () => {
    const { ctx, calls } = fakeContext();
    const result = await handleTool('generate_drive_cse_token', { file_id: 'f1', parent_id: 'p1' }, ctx);
    assert.equal(result?.isError, true);
    assert.equal(calls.length, 0);
  });

  it('supports revision update and delete routes', async () => {
    const first = fakeContext();
    const update = await handleTool('manage_file_revision', { file_id: 'f1', revision_id: 'r1', action: 'update', keep_forever: true }, first.ctx);
    assert.equal(update?.isError, false);
    assert.equal(first.calls[0].method, 'PATCH');
    assert.equal(first.calls[0].data.keepForever, true);

    const second = fakeContext();
    const del = await handleTool('manage_file_revision', { file_id: 'f1', revision_id: 'r1', action: 'delete' }, second.ctx);
    assert.equal(del?.isError, false);
    assert.equal(second.calls[0].method, 'DELETE');
  });
});
