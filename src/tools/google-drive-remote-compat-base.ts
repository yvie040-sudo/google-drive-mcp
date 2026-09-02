import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { errorResponse } from '../types.js';

const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const SLIDES_MIME = 'application/vnd.google-apps.presentation';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function def(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) } };
}

function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }], isError: false };
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(JSON.stringify(value ?? null), 'utf8');
}

function readableMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json';
}

export function googleMcpFileShape(file: any, contentSnippet?: string): Record<string, unknown> {
  const parentId = Array.isArray(file.parents) && file.parents.length ? file.parents[0] : undefined;
  const owner = Array.isArray(file.owners) && file.owners.length ? file.owners[0]?.emailAddress : undefined;
  return {
    id: file.id,
    title: file.name,
    ...(parentId ? { parentId } : {}),
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    ...(file.size !== undefined && file.size !== null ? { fileSize: String(file.size) } : {}),
    ...(file.description ? { description: file.description } : {}),
    ...(file.fileExtension ? { fileExtension: file.fileExtension } : {}),
    ...(contentSnippet ? { contentSnippet } : {}),
    ...(file.webViewLink ? { viewUrl: file.webViewLink } : {}),
    ...(file.sharedWithMeTime ? { sharedWithMeTime: file.sharedWithMeTime } : {}),
    ...(file.createdTime ? { createdTime: file.createdTime } : {}),
    ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
    ...(file.viewedByMeTime ? { viewedByMeTime: file.viewedByMeTime } : {}),
    ...(owner ? { owner } : {}),
    canAddChildren: file.mimeType === FOLDER_MIME ? Boolean(file.capabilities?.canAddChildren) : false,
  };
}

async function snippetFor(ctx: ToolContext, file: any): Promise<string | undefined> {
  const fileId = file.id;
  const mimeType = file.mimeType || '';
  if (!fileId || file.capabilities?.canDownload === false) return undefined;
  try {
    let data: unknown;
    if (mimeType === DOC_MIME) data = (await ctx.getDrive().files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' })).data;
    else if (mimeType === SHEET_MIME) data = (await ctx.getDrive().files.export({ fileId, mimeType: 'text/csv' }, { responseType: 'text' })).data;
    else if (mimeType === SLIDES_MIME) data = (await ctx.getDrive().files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' })).data;
    else if (readableMime(mimeType)) data = (await ctx.getDrive().files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' })).data;
    else return undefined;
    const text = String(data ?? '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

async function listFiles(ctx: ToolContext, params: any, excludeContentSnippets: boolean): Promise<any> {
  const response = await ctx.getDrive().files.list({
    ...params,
    fields: 'nextPageToken,files(id,name,parents,mimeType,size,description,fileExtension,webViewLink,sharedWithMeTime,createdTime,modifiedTime,viewedByMeTime,owners(emailAddress),capabilities(canAddChildren,canDownload))',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });
  const files = await Promise.all((response.data.files ?? []).map(async (file: any) => googleMcpFileShape(file, excludeContentSnippets ? undefined : await snippetFor(ctx, file))));
  return { files, ...(response.data.nextPageToken ? { nextPageToken: response.data.nextPageToken } : {}) };
}

function translateGoogleMcpQuery(query: string): string {
  let out = query.trim();
  if (!out) return 'trashed = false';
  out = out.replace(/\btitle\b/g, 'name');
  out = out.replace(/\bparentId\s*=\s*('(?:\\'|[^'])*')/g, '$1 in parents');
  out = out.replace(/\bparentId\s*!=\s*('(?:\\'|[^'])*')/g, 'not $1 in parents');
  out = out.replace(/\bowner\s*=\s*('(?:\\'|[^'])*')/g, '$1 in owners');
  out = out.replace(/\bowner\s*!=\s*('(?:\\'|[^'])*')/g, 'not $1 in owners');
  out = out.replace(/\bsharedWithMe\s*=\s*true\b/gi, 'sharedWithMe');
  out = out.replace(/\bsharedWithMe\s*=\s*false\b/gi, 'not sharedWithMe');
  if (!/\btrashed\s*=/.test(out)) out = `(${out}) and trashed = false`;
  return out;
}

function commentThread(comment: any): any {
  const post = (value: any, fallbackId: string) => ({
    postId: value?.id || fallbackId,
    content: value?.content || '',
    authorName: value?.author?.displayName || '',
    modifiedTime: value?.modifiedTime || value?.createdTime,
  });
  return {
    commentId: comment.id,
    status: comment.resolved ? 'RESOLVED' : 'OPEN',
    headPost: post(comment, comment.id),
    replies: (comment.replies ?? []).filter((reply: any) => !reply.deleted).map((reply: any) => post(reply, reply.id)),
  };
}

async function readContent(ctx: ToolContext, fileId: string): Promise<{ fileContent: string; textFormattingNotSupported?: boolean }> {
  const metadata = await ctx.getDrive().files.get({ fileId, fields: 'id,name,mimeType,capabilities(canDownload)', supportsAllDrives: true });
  const mimeType = metadata.data.mimeType || '';
  if (metadata.data.capabilities?.canDownload === false) return { fileContent: '', textFormattingNotSupported: true };
  try {
    if (mimeType === DOC_MIME) return { fileContent: String((await ctx.getDrive().files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' })).data ?? '') };
    if (mimeType === SHEET_MIME) return { fileContent: String((await ctx.getDrive().files.export({ fileId, mimeType: 'text/csv' }, { responseType: 'text' })).data ?? '') };
    if (mimeType === SLIDES_MIME) return { fileContent: String((await ctx.getDrive().files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' })).data ?? '') };
    if (readableMime(mimeType)) return { fileContent: String((await ctx.getDrive().files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' })).data ?? '') };
    return { fileContent: '', textFormattingNotSupported: true };
  } catch {
    return { fileContent: '', textFormattingNotSupported: true };
  }
}

export const toolDefinitions: ToolDefinition[] = [
  def('download_file_content', 'Google first-party Drive MCP compatibility: download file content as base64.', { fileId: { type: 'string' }, exportMimeType: { type: 'string' } }, ['fileId']),
  def('get_file_permissions', 'Google first-party Drive MCP compatibility: list file permissions.', { fileId: { type: 'string' } }, ['fileId']),
  def('list_recent_files', 'Google first-party Drive MCP compatibility: list recent Drive files.', { orderBy: { type: 'string', enum: ['recency','lastModified','lastModifiedByMe'] }, pageToken: { type: 'string' }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 10 }, excludeContentSnippets: { type: 'boolean' } }),
  def('read_file_content', 'Google first-party Drive MCP compatibility: natural-language file content with optional comments.', { fileId: { type: 'string' }, includeComments: { type: 'boolean' } }, ['fileId']),
  def('search_files', 'Google first-party Drive MCP compatibility: structured Drive search.', { query: { type: 'string' }, pageToken: { type: 'string' }, pageSize: { type: 'integer', minimum: 1, maximum: 100 }, excludeContentSnippets: { type: 'boolean' } }),
];

export async function handleTool(toolName: string, args: Record<string, any>, ctx: ToolContext): Promise<ToolResult | null> {
  try {
    switch (toolName) {
      case 'download_file_content': {
        const fileId = String(args.fileId || '');
        if (!fileId) return errorResponse('fileId is required.');
        const metadata = await ctx.getDrive().files.get({ fileId, fields: 'id,name,mimeType,capabilities(canDownload)', supportsAllDrives: true });
        if (metadata.data.capabilities?.canDownload === false) return errorResponse('Google Drive reports capabilities.canDownload=false for this file.');
        const sourceMime = metadata.data.mimeType || 'application/octet-stream';
        let outputMime = sourceMime;
        let data: unknown;
        if (sourceMime.startsWith('application/vnd.google-apps.')) {
          outputMime = args.exportMimeType || (sourceMime === SHEET_MIME ? 'text/csv' : 'text/plain');
          data = (await ctx.getDrive().files.export({ fileId, mimeType: outputMime }, { responseType: 'arraybuffer' })).data;
        } else {
          data = (await ctx.getDrive().files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' })).data;
        }
        return json({ id: fileId, title: metadata.data.name, mimeType: outputMime, content: toBuffer(data).toString('base64') });
      }
      case 'get_file_permissions': {
        const fileId = String(args.fileId || '');
        if (!fileId) return errorResponse('fileId is required.');
        const response = await ctx.getDrive().permissions.list({ fileId, fields: 'permissions(role,displayName,type,emailAddress,view)', supportsAllDrives: true });
        return json({ permissions: response.data.permissions ?? [] });
      }
      case 'list_recent_files': {
        const orderBy = args.orderBy || 'recency';
        const map: Record<string, string> = { recency: 'recency desc', lastModified: 'modifiedTime desc', lastModifiedByMe: 'modifiedByMeTime desc' };
        if (!map[orderBy]) return errorResponse('orderBy must be recency, lastModified, or lastModifiedByMe.');
        return json(await listFiles(ctx, { q: 'trashed = false', orderBy: map[orderBy], pageSize: Math.min(Math.max(Number(args.pageSize ?? 10), 1), 100), pageToken: args.pageToken }, Boolean(args.excludeContentSnippets)));
      }
      case 'read_file_content': {
        const fileId = String(args.fileId || '');
        if (!fileId) return errorResponse('fileId is required.');
        const content = await readContent(ctx, fileId);
        if (!args.includeComments) return json(content);
        try {
          const response = await ctx.getDrive().comments.list({ fileId, includeDeleted: false, pageSize: 100, fields: 'nextPageToken,comments(id,content,anchor,quotedFileContent,resolved,author,createdTime,modifiedTime,replies(id,content,action,author,createdTime,modifiedTime,deleted))' });
          const anchored: any[] = []; const unanchored: any[] = [];
          for (const comment of response.data.comments ?? []) (comment.anchor ? anchored : unanchored).push(commentThread(comment));
          return json({ ...content, contentAnchoredComments: anchored, unanchoredComments: unanchored, ...(response.data.nextPageToken ? { commentsNotSupported: false, commentsPartial: true, commentsNextPageToken: response.data.nextPageToken } : {}) });
        } catch {
          return json({ ...content, commentsNotSupported: true });
        }
      }
      case 'search_files': {
        const query = translateGoogleMcpQuery(String(args.query || ''));
        return json(await listFiles(ctx, { q: query, pageSize: Math.min(Math.max(Number(args.pageSize ?? 10), 1), 100), pageToken: args.pageToken, orderBy: 'modifiedTime desc' }, Boolean(args.excludeContentSnippets)));
      }
      default: return null;
    }
  } catch (error: any) {
    return errorResponse(error?.message || String(error));
  }
}
