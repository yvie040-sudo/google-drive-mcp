import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleTool, toolDefinitions } from '../../src/tools/google-drive-extended.js';

function fakeContext() {
  const calls: Array<{ method: string; args: any }> = [];
  const drive: any = {
    files: {
      get: async (args: any) => { calls.push({ method: 'files.get', args }); return { data: { capabilities: { canStartApproval: true } } }; },
      update: async (args: any) => { calls.push({ method: 'files.update', args }); return { data: { id: args.fileId, trashed: false } }; },
      list: async (args: any) => { calls.push({ method: 'files.list', args }); return { data: { files: [] } }; },
    },
  };
  const authClient = {
    request: async (args: any) => {
      calls.push({ method: `auth.${args.method || 'GET'}`, args });
      return { data: { ok: true } };
    },
  };
  return { ctx: { authClient, getDrive: () => drive } as any, calls };
}

describe('Google Drive extended power pack', () => {
  it('advertises 13 separately scoped extensions', () => {
    assert.equal(toolDefinitions.length, 13);
    assert.equal(new Set(toolDefinitions.map((tool) => tool.name)).size, 13);
  });

  it('requires reviewers before starting an approval and preflights canStartApproval', async () => {
    const denied = fakeContext();
    const bad = await handleTool('manage_drive_approval', { file_id: 'f1', action: 'start', reviewer_emails: [] }, denied.ctx);
    assert.equal(bad?.isError, true);
    assert.equal(denied.calls.length, 0);

    const allowed = fakeContext();
    const good = await handleTool('manage_drive_approval', { file_id: 'f1', action: 'start', reviewer_emails: ['reviewer@example.com'] }, allowed.ctx);
    assert.equal(good?.isError, false);
    assert.ok(allowed.calls.find((call) => call.method === 'files.get'));
    const post = allowed.calls.find((call) => call.method === 'auth.POST');
    assert.match(post?.args.url || '', /\/files\/f1\/approvals:start$/);
    assert.deepEqual(post?.args.data.reviewerEmails, ['reviewer@example.com']);
  });

  it('routes applied file labels through Drive v3 modifyLabels atomically', async () => {
    const { ctx, calls } = fakeContext();
    const result = await handleTool('modify_file_labels', { file_id: 'f1', label_modifications: [{ labelId: 'L1', removeLabel: true }] }, ctx);
    assert.equal(result?.isError, false);
    const post = calls.find((call) => call.method === 'auth.POST');
    assert.match(post?.args.url || '', /\/files\/f1\/modifyLabels$/);
    assert.deepEqual(post?.args.data.labelModifications, [{ labelId: 'L1', removeLabel: true }]);
  });

  it('routes Drive Activity v2 queries with an items/ identifier', async () => {
    const { ctx, calls } = fakeContext();
    const result = await handleTool('query_drive_activity', { item_id: 'f1', filter: 'time > 2026-01-01T00:00:00Z' }, ctx);
    assert.equal(result?.isError, false);
    const post = calls.find((call) => call.method === 'auth.POST');
    assert.equal(post?.args.url, 'https://driveactivity.googleapis.com/v2/activity:query');
    assert.equal(post?.args.data.itemName, 'items/f1');
  });

  it('routes Drive Labels catalog reads to the Labels v2 API', async () => {
    const { ctx, calls } = fakeContext();
    const result = await handleTool('drive_labels_catalog', { action: 'get', name: 'labels/L1@published' }, ctx);
    assert.equal(result?.isError, false);
    const get = calls.find((call) => call.method === 'auth.GET');
    assert.match(get?.args.url || '', /drivelabels\.googleapis\.com\/v2\/labels\/L1@published$/);
  });

  it('requires domain-admin mode when deleting shared-drive items with the drive', async () => {
    const { ctx, calls } = fakeContext();
    const result = await handleTool('manage_shared_drive', { action: 'delete', drive_id: 'd1', allow_item_deletion: true, use_domain_admin_access: false }, ctx);
    assert.equal(result?.isError, true);
    assert.equal(calls.length, 0);
  });

  it('routes incremental changes and trash restore correctly', async () => {
    const first = fakeContext();
    const changes = await handleTool('list_drive_changes', { page_token: 'tok', drive_id: 'd1' }, first.ctx);
    assert.equal(changes?.isError, false);
    const get = first.calls.find((call) => call.method === 'auth.GET');
    assert.match(get?.args.url || '', /\/drive\/v3\/changes$/);
    assert.equal(get?.args.params.pageToken, 'tok');
    assert.equal(get?.args.params.driveId, 'd1');

    const second = fakeContext();
    const restore = await handleTool('restore_from_trash', { file_id: 'f1' }, second.ctx);
    assert.equal(restore?.isError, false);
    const update = second.calls.find((call) => call.method === 'files.update');
    assert.equal(update?.args.requestBody.trashed, false);
  });
});
