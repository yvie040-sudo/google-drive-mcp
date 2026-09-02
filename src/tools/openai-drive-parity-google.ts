import { Readable } from 'node:stream';
import * as openai from './openai-drive-parity-openai.js';
import { googleMcpFileShape, handleTool as googleRemoteTool } from './google-drive-remote-compat.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { errorResponse } from '../types.js';

const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const SLIDES_MIME = 'application/vnd.google-apps.presentation';

const DOC_INPUTS = new Set([
  'text/plain','text/markdown','text/html','application/rtf','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text','application/x-vnd.oasis.opendocument.text',
]);
const SHEET_INPUTS = new Set([
  'text/csv','text/tab-separated-values','application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
]);
const SLIDE_INPUTS = new Set([
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
]);

function mergeDefinitions(definition: any): ToolDefinition {
  if (!['copy_file','create_file','get_file_metadata'].includes(definition.name)) return definition;
  const inputSchema = { ...(definition.inputSchema ?? {}) };
  const properties = { ...((inputSchema as any).properties ?? {}) } as Record<string, any>;
  if (definition.name === 'copy_file') {
    Object.assign(properties, { fileId: { type: 'string' }, title: { type: 'string' }, parentId: { type: 'string' } });
    (inputSchema as any).required = [];
  }
  if (definition.name === 'create_file') {
    Object.assign(properties, {
      mimeType: { type: 'string', description: 'Deprecated Google MCP compatibility field; prefer contentMimeType.' },
      contentMimeType: { type: 'string' }, content: { type: 'string' }, base64Content: { type: 'string' }, textContent: { type: 'string' },
      parentId: { type: 'string' }, disableConversionToGoogleType: { type: 'boolean' },
    });
    (inputSchema as any).required = ['title'];
  }
  if (definition.name === 'get_file_metadata') properties.excludeContentSnippets = { type: 'boolean' };
  (inputSchema as any).properties = properties;
  return { ...definition, inputSchema } as ToolDefinition;
}

export const toolDefinitions: ToolDefinition[] = openai.toolDefinitions.map(mergeDefinitions);

type DecodedContent =
  | { ok: true; body?: Buffer; mimeType?: string }
  | { ok: false; result: ToolResult };

function targetMime(contentMime: string, disable: boolean): string {
  if (disable) return contentMime;
  if (DOC_INPUTS.has(contentMime)) return DOC_MIME;
  if (SHEET_INPUTS.has(contentMime)) return SHEET_MIME;
  if (SLIDE_INPUTS.has(contentMime)) return SLIDES_MIME;
  return contentMime;
}

function decodeGoogleContent(args: Record<string, any>): DecodedContent {
  const variants = [args.base64Content !== undefined, args.textContent !== undefined, args.content !== undefined].filter(Boolean).length;
  if (variants > 1) return { ok: false, result: errorResponse('Set only one of base64Content, textContent, or deprecated content.') };
  if (variants === 0) return { ok: true };
  const mimeType = args.contentMimeType || args.mimeType;
  if (!mimeType) return { ok: false, result: errorResponse('contentMimeType is required when content is provided.') };
  if (args.textContent !== undefined) return { ok: true, body: Buffer.from(String(args.textContent), 'utf8'), mimeType };
  const compact = String(args.base64Content ?? args.content ?? '').replace(/\s+/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    return { ok: false, result: errorResponse('base64Content/content must be valid base64.') };
  }
  return { ok: true, body: Buffer.from(compact, 'base64'), mimeType };
}

function isGoogleCreate(args: Record<string, any>): boolean {
  return ['mimeType','contentMimeType','content','base64Content','textContent','parentId','disableConversionToGoogleType']
    .some((key) => key in args) && !('mime_type' in args);
}

function textOf(result: ToolResult | null): string | undefined {
  const block = result?.content?.find((item) => item.type === 'text' && typeof item.text === 'string');
  return block?.text;
}

async function googleMetadata(fileId: string, excludeContentSnippets: boolean | undefined, ctx: ToolContext): Promise<ToolResult> {
  const response = await ctx.getDrive().files.get({
    fileId,
    fields: 'id,name,parents,mimeType,size,description,fileExtension,webViewLink,sharedWithMeTime,createdTime,modifiedTime,viewedByMeTime,owners(emailAddress),driveId,resourceKey,trashed,starred,shared,capabilities,permissions',
    supportsAllDrives: true,
  });
  let snippet: string | undefined;
  if (excludeContentSnippets !== true) {
    const read = await googleRemoteTool('read_file_content', { fileId, includeComments: false }, ctx);
    const raw = textOf(read);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const content = typeof parsed.fileContent === 'string' ? parsed.fileContent.replace(/\s+/g, ' ').trim() : '';
        if (content) snippet = content.slice(0, 500);
      } catch { /* best-effort snippet only */ }
    }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ ...response.data, ...googleMcpFileShape(response.data, snippet) }, null, 2) }],
    isError: false,
  };
}

function hasOpenAiMetadataOptions(args: Record<string, any>): boolean {
  return ['acknowledgeAbuse','supportsAllDrives','supportsTeamDrives','includePermissionsForView','includeLabels','fields']
    .some((key) => key in args);
}

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  const a = args as Record<string, any>;
  try {
    if (toolName === 'copy_file' && typeof a.fileId === 'string' && a.fileId) {
      const response = await ctx.getDrive().files.copy({
        fileId: a.fileId,
        requestBody: { ...(a.title ? { name: a.title } : {}), ...(a.parentId ? { parents: [a.parentId] } : {}) },
        fields: 'id,name,parents,mimeType,size,description,fileExtension,webViewLink,sharedWithMeTime,createdTime,modifiedTime,viewedByMeTime,owners(emailAddress),capabilities(canAddChildren)',
        supportsAllDrives: true,
      });
      return { content: [{ type: 'text', text: JSON.stringify(googleMcpFileShape(response.data), null, 2) }], isError: false };
    }
    if (toolName === 'create_file' && isGoogleCreate(a)) {
      const decoded = decodeGoogleContent(a);
      if (!decoded.ok) return decoded.result;
      const contentMime = decoded.mimeType || a.contentMimeType || a.mimeType || 'text/plain';
      const outputMime = targetMime(contentMime, Boolean(a.disableConversionToGoogleType));
      const requestBody: any = { name: a.title || 'Untitled', mimeType: outputMime, ...(a.parentId ? { parents: [a.parentId] } : {}) };
      const params: any = {
        requestBody,
        fields: 'id,name,parents,mimeType,size,description,fileExtension,webViewLink,sharedWithMeTime,createdTime,modifiedTime,viewedByMeTime,owners(emailAddress),capabilities(canAddChildren)',
        supportsAllDrives: true,
      };
      if (decoded.body) params.media = { mimeType: contentMime, body: Readable.from(decoded.body) };
      const response = await ctx.getDrive().files.create(params);
      return { content: [{ type: 'text', text: JSON.stringify(googleMcpFileShape(response.data), null, 2) }], isError: false };
    }
    if (toolName === 'get_file_metadata' && typeof a.fileId === 'string' && a.fileId) {
      if (hasOpenAiMetadataOptions(a) && !('excludeContentSnippets' in a)) return openai.handleTool(toolName, args, ctx);
      return googleMetadata(a.fileId, a.excludeContentSnippets, ctx);
    }
    return openai.handleTool(toolName, args, ctx);
  } catch (error: any) {
    return errorResponse(error?.message || String(error));
  }
}
