import * as core from './openai-drive-parity-core.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { errorResponse } from '../types.js';

export const toolDefinitions: ToolDefinition[] = core.toolDefinitions;

function extractId(value: string): string {
  const raw = value.trim();
  if (!/^https?:\/\//i.test(raw)) return raw;
  for (const pattern of [/\/d\/([A-Za-z0-9_-]+)/, /\/folders\/([A-Za-z0-9_-]+)/, /[?&]id=([A-Za-z0-9_-]+)/]) {
    const match = raw.match(pattern);
    if (match) return match[1];
  }
  throw new Error(`Could not extract a Google Drive ID from ${raw}`);
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(JSON.stringify(data ?? null), 'utf8');
}

function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || /json|xml|csv|markdown|javascript/i.test(mimeType);
}

async function exportAsMcpResource(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const value = typeof args.id === 'string' && args.id ? args.id : typeof args.url === 'string' ? args.url : '';
  if (!value) return errorResponse('id or url is required.');
  const fileId = extractId(value);
  const mimeType = typeof args.mime_type === 'string' && args.mime_type ? args.mime_type : 'application/pdf';
  const metadata = await ctx.getDrive().files.get({
    fileId,
    fields: 'id,name,mimeType,capabilities(canDownload)',
    supportsAllDrives: true,
  });
  if (metadata.data.capabilities?.canDownload === false) return errorResponse('Google Drive reports capabilities.canDownload=false for this file.');
  const response = await ctx.getDrive().files.export({ fileId, mimeType }, { responseType: 'arraybuffer' });
  const data = toBuffer(response.data);
  const uri = `gdrive-export:///${fileId}`;
  return {
    content: [{
      type: 'resource',
      resource: isTextMime(mimeType)
        ? { uri, mimeType, text: data.toString('utf8') }
        : { uri, mimeType, blob: data.toString('base64') },
    }],
    isError: false,
  };
}

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  try {
    if (toolName === 'export_file') return exportAsMcpResource(args, ctx);
    return core.handleTool(toolName, args, ctx);
  } catch (error: any) {
    return errorResponse(error?.message || String(error));
  }
}
