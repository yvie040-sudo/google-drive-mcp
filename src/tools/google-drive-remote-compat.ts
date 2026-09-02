import * as local from './google-drive-remote-compat-base.js';
import * as openaiLocal from './openai-drive-parity-openai.js';
import { tryGoogleFirstPartyDriveTool } from './google-drive-first-party-client.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

const GOOGLE_UNIQUE_TOOLS = new Set([
  'download_file_content',
  'get_file_permissions',
  'list_recent_files',
  'read_file_content',
  'search_files',
]);

export const toolDefinitions: ToolDefinition[] = local.toolDefinitions;
export { googleMcpFileShape } from './google-drive-remote-compat-base.js';

function textPayload(result: ToolResult | null): any | null {
  const block = result?.content?.find((item) => item.type === 'text' && typeof item.text === 'string');
  if (!block?.text) return null;
  try { return JSON.parse(block.text); } catch { return null; }
}

async function strengthenLocalRead(
  args: Record<string, unknown>,
  localResult: ToolResult | null,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  const payload = textPayload(localResult);
  if (!payload?.textFormattingNotSupported || typeof args.fileId !== 'string') return localResult;
  const fetched = await openaiLocal.handleTool('fetch', { url: args.fileId }, ctx);
  const fetchedPayload = textPayload(fetched);
  if (!fetchedPayload || typeof fetchedPayload.text !== 'string' || !fetchedPayload.text) return localResult;
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ...payload, fileContent: fetchedPayload.text, textFormattingNotSupported: false }, null, 2),
    }],
    isError: false,
  };
}

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (!GOOGLE_UNIQUE_TOOLS.has(toolName)) return null;
  const providerResult = await tryGoogleFirstPartyDriveTool(ctx, toolName, args);
  if (providerResult !== null) return providerResult;
  const localResult = await local.handleTool(toolName, args as Record<string, any>, ctx);
  return toolName === 'read_file_content' ? strengthenLocalRead(args, localResult, ctx) : localResult;
}
