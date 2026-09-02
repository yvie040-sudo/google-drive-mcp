import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  OPENAI_DRIVE_TOOL_NAMES,
  GOOGLE_DRIVE_REMOTE_MCP_TOOL_NAMES,
  NICK_DRIVE_EXTRA_TOOL_NAMES,
  NICK_DRIVE_EXTENDED_TOOL_NAMES,
  GOOGLE_DRIVE_V3_COMPLETION_TOOL_NAMES,
} from '../../src/parity/openai-drive-contract.js';
import { setupTestServer, type TestContext } from '../helpers/setup-server.js';

const EXPECTED_TOOL_COUNT = 195;

describe('Tool Registry', () => {
  let ctx: TestContext;
  let tools: Array<{ name: string; inputSchema?: any; _meta?: Record<string, unknown> }>;

  before(async () => { ctx = await setupTestServer(); tools = (await ctx.client.listTools()).tools as any; });
  after(async () => { await ctx.cleanup(); });

  it(`registers exactly ${EXPECTED_TOOL_COUNT} tools`, () => { assert.equal(tools.length, EXPECTED_TOOL_COUNT); });
  it('has no duplicate names and every schema is an object', () => {
    const names = tools.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length);
    for (const tool of tools) {
      assert.ok(tool.name);
      assert.equal(tool.inputSchema?.type, 'object', `${tool.name} must advertise an object schema`);
    }
  });
  it('advertises the exact current 45-name OpenAI Google Drive surface', () => {
    assert.equal(new Set(OPENAI_DRIVE_TOOL_NAMES).size, 45);
    const names = new Set(tools.map((tool) => tool.name));
    assert.deepEqual(OPENAI_DRIVE_TOOL_NAMES.filter((name) => !names.has(name)), []);
  });
  it('advertises the exact Google first-party Drive MCP 8-name surface', () => {
    assert.equal(new Set(GOOGLE_DRIVE_REMOTE_MCP_TOOL_NAMES).size, 8);
    const names = new Set(tools.map((tool) => tool.name));
    assert.deepEqual(GOOGLE_DRIVE_REMOTE_MCP_TOOL_NAMES.filter((name) => !names.has(name)), []);
  });
  it('advertises every Nick Drive power and Drive-v3 completion extension', () => {
    const names = new Set(tools.map((tool) => tool.name));
    assert.deepEqual(NICK_DRIVE_EXTRA_TOOL_NAMES.filter((name) => !names.has(name)), []);
    assert.deepEqual(NICK_DRIVE_EXTENDED_TOOL_NAMES.filter((name) => !names.has(name)), []);
    assert.deepEqual(GOOGLE_DRIVE_V3_COMPLETION_TOOL_NAMES.filter((name) => !names.has(name)), []);
  });
  it('every advertised tool reaches a handler rather than Tool not found', async () => {
    const previous = process.env.GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK;
    process.env.GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK = 'false';
    try {
      for (const tool of tools) {
        const result = await ctx.client.callTool({ name: tool.name, arguments: {} });
        const text = (result as any).content?.[0]?.text || '';
        assert.ok(!text.includes('Tool not found'), `${tool.name} has no handler`);
      }
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK;
      else process.env.GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK = previous;
    }
  });
  it('marks OpenAI file-bearing arguments through standard _meta metadata', () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const fileParams = (name: string) => byName.get(name)?._meta?.['openai/fileParams'];
    for (const name of ['import_document','import_presentation','import_spreadsheet']) assert.deepEqual(fileParams(name), ['source_file']);
    assert.deepEqual(fileParams('upload_file'), ['file_uri']);
    assert.deepEqual(fileParams('update_file'), ['file_uri']);
    for (const name of ['batch_update_document','batch_update_presentation','batch_update_spreadsheet']) assert.deepEqual(fileParams(name), ['image_uris']);
  });
  it('keeps overlapping OpenAI/Google names dual-schema compatible', () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool.inputSchema?.properties ?? {}]));
    assert.ok('url' in (byName.get('copy_file') as any));
    assert.ok('fileId' in (byName.get('copy_file') as any));
    assert.ok('mime_type' in (byName.get('create_file') as any));
    assert.ok('contentMimeType' in (byName.get('create_file') as any));
    assert.ok('fields' in (byName.get('get_file_metadata') as any));
    assert.ok('excludeContentSnippets' in (byName.get('get_file_metadata') as any));
  });
});
