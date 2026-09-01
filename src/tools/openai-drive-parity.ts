import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as base from './openai-drive-parity-base.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { errorResponse } from '../types.js';

const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const SLIDES_MIME = 'application/vnd.google-apps.presentation';
const DRAWING_MIME = 'application/vnd.google-apps.drawing';
const SCRIPT_MIME = 'application/vnd.google-apps.script';
const VIDS_MIME = 'application/vnd.google-apps.vid';

const DEFAULT_NATIVE_EXPORT: Record<string, string> = {
  [DOC_MIME]: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  [SHEET_MIME]: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  [SLIDES_MIME]: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  [DRAWING_MIME]: 'image/png',
  [SCRIPT_MIME]: 'application/vnd.google-apps.script+json',
  [VIDS_MIME]: 'video/mp4',
};

const PROVIDED_FILE_SCHEMA = {
  type: 'object',
  properties: {
    download_url: { type: 'string' },
    file_id: { type: 'string' },
    mime_type: { type: 'string' },
    file_name: { type: 'string' },
  },
  required: ['download_url', 'file_id'],
  additionalProperties: true,
};

type Materialized = { path: string; fileName?: string; downloaded: boolean };

function fileParamsFrom(definition: any): string[] {
  return Array.isArray(definition.fileParams) ? definition.fileParams.filter((value: unknown): value is string => typeof value === 'string') : [];
}

function withProvidedFileSchemas(definition: any, fileParams: string[]): ToolDefinition {
  const { fileParams: _legacyFileParams, ...rest } = definition;
  const inputSchema = { ...(rest.inputSchema ?? {}) };
  const properties = { ...((inputSchema as any).properties ?? {}) } as Record<string, any>;
  for (const field of fileParams) {
    const current = properties[field] ?? {};
    const isArray = current?.type === 'array' || current?.items !== undefined;
    properties[field] = isArray
      ? { ...current, type: 'array', items: PROVIDED_FILE_SCHEMA }
      : { ...current, ...PROVIDED_FILE_SCHEMA };
  }
  (inputSchema as any).properties = properties;
  return {
    ...rest,
    inputSchema,
    _meta: {
      ...(rest._meta ?? {}),
      'openai/fileParams': fileParams,
    },
  } as ToolDefinition;
}

export const toolDefinitions: ToolDefinition[] = base.toolDefinitions.map((definition: any) => {
  const fileParams = fileParamsFrom(definition);
  return fileParams.length ? withProvidedFileSchemas(definition, fileParams) : definition;
});

function extractId(value: string): string {
  const raw = value.trim();
  if (!/^https?:\/\//i.test(raw)) return raw;
  for (const pattern of [/\/d\/([A-Za-z0-9_-]+)/, /\/folders\/([A-Za-z0-9_-]+)/, /[?&]id=([A-Za-z0-9_-]+)/]) {
    const match = raw.match(pattern);
    if (match) return match[1];
  }
  throw new Error(`Could not extract a Drive ID from ${raw}`);
}

function pickId(args: Record<string, any>): string {
  const value = args.id ?? args.url;
  if (typeof value !== 'string' || !value.trim()) throw new Error('id or url is required');
  return extractId(value);
}

function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }], isError: false };
}

function bufferFrom(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(JSON.stringify(value ?? null), 'utf8');
}

function embedded(uri: string, mimeType: string, data: Buffer): ToolResult {
  if (mimeType.startsWith('text/') || /json|xml|csv|markdown|javascript/i.test(mimeType)) {
    return { content: [{ type: 'resource', resource: { uri, mimeType, text: data.toString('utf8') } }], isError: false };
  }
  return { content: [{ type: 'resource', resource: { uri, mimeType, blob: data.toString('base64') } }], isError: false };
}

function linked(name: string, uri: string, mimeType?: string, size?: number): ToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify({ name, uri, mimeType, size: size ?? null }, null, 2) },
      { type: 'resource_link', name, uri, ...(mimeType ? { mimeType } : {}), ...(size ? { size } : {}) },
    ],
    isError: false,
  };
}

async function startDownload(ctx: ToolContext, fileId: string, mimeType: string | undefined, resourceKey?: string | null): Promise<any> {
  const headers: Record<string, string> = {};
  if (resourceKey) headers['X-Goog-Drive-Resource-Keys'] = `${fileId}/${resourceKey}`;
  return (await ctx.authClient.request({
    url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/download`,
    method: 'POST',
    params: mimeType ? { mimeType } : {},
    headers,
  })).data;
}

async function pollDownload(ctx: ToolContext, operation: any): Promise<any> {
  let current = operation;
  const delays = [250, 500, 1000, 2000, 4000, 8000];
  for (const delay of delays) {
    if (current?.done) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    current = (await ctx.authClient.request({
      url: `https://www.googleapis.com/drive/v3/${String(current.name).replace(/^\//, '')}`,
      method: 'GET',
    })).data;
  }
  return current;
}

async function handleExport(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
  const fileId = pickId(args);
  const mimeType = args.mime_type || 'application/pdf';
  const metadata = await ctx.getDrive().files.get({
    fileId,
    fields: 'id,name,mimeType,size,exportLinks,capabilities(canDownload)',
    supportsAllDrives: true,
  });
  if (metadata.data.capabilities?.canDownload === false) return errorResponse('Google Drive reports capabilities.canDownload=false for this file.');
  const exportUrl = metadata.data.exportLinks?.[mimeType];
  if (!exportUrl) return errorResponse(`Google Drive does not expose export MIME type ${mimeType} for this file.`);
  return linked(metadata.data.name || `export-${fileId}`, exportUrl, mimeType);
}

async function handleFetchRaw(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
  const fileId = pickId(args);
  const metadata = await ctx.getDrive().files.get({
    fileId,
    fields: 'id,name,mimeType,size,resourceKey,webContentLink,exportLinks,capabilities(canDownload)',
    supportsAllDrives: true,
  });
  const file = metadata.data;
  if (file.capabilities?.canDownload === false) return errorResponse('Google Drive reports capabilities.canDownload=false for this file.');
  const sourceMime = file.mimeType || 'application/octet-stream';
  const native = sourceMime.startsWith('application/vnd.google-apps.');
  const requestedMime = args.raw_export_mime_type || (native ? DEFAULT_NATIVE_EXPORT[sourceMime] : undefined);

  if (native && !requestedMime) {
    return errorResponse(`No safe default raw export is defined for native MIME type ${sourceMime}. Supply raw_export_mime_type when Google supports one, or use download_file_lro.`);
  }

  if (args.include_base64 === false || sourceMime === VIDS_MIME) {
    const operation = await pollDownload(ctx, await startDownload(ctx, fileId, requestedMime, file.resourceKey));
    if (!operation?.done) {
      return json({ file, operation, complete: false, next: 'Call get_download_operation with operation_name to continue polling.' });
    }
    if (operation.error) return errorResponse(`Drive download operation failed: ${JSON.stringify(operation.error)}`);
    const downloadUri = operation.response?.downloadUri;
    if (!downloadUri) return errorResponse('Drive download operation completed without a downloadUri.');
    if (args.include_base64 === false) return linked(file.name || `drive-${fileId}`, downloadUri, requestedMime || sourceMime, file.size ? Number(file.size) : undefined);
    const response = await ctx.authClient.request({ url: downloadUri, responseType: 'arraybuffer' });
    return embedded(`gdrive-download:///${fileId}`, requestedMime || sourceMime, bufferFrom(response.data));
  }

  if (native && ![DOC_MIME, SHEET_MIME, SLIDES_MIME].includes(sourceMime)) {
    const response = await ctx.getDrive().files.export({ fileId, mimeType: requestedMime }, { responseType: 'arraybuffer' });
    return embedded(`gdrive:///${fileId}`, requestedMime, bufferFrom(response.data));
  }

  return (await base.handleTool('fetch', args, ctx)) ?? errorResponse('fetch handler unavailable');
}

async function handleReadableNative(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult | null> {
  if (args.download_raw_file) return null;
  const fileId = pickId(args);
  const metadata = await ctx.getDrive().files.get({ fileId, fields: 'id,name,mimeType,capabilities(canDownload)', supportsAllDrives: true });
  const mimeType = metadata.data.mimeType || '';
  if (metadata.data.capabilities?.canDownload === false) return errorResponse('Google Drive reports capabilities.canDownload=false for this file.');
  if (mimeType === DRAWING_MIME) {
    const response = await ctx.getDrive().files.export({ fileId, mimeType: 'image/png' }, { responseType: 'arraybuffer' });
    const data = bufferFrom(response.data);
    return { content: [{ type: 'text', text: JSON.stringify(metadata.data, null, 2) }, { type: 'image', data: data.toString('base64'), mimeType: 'image/png' }], isError: false };
  }
  if (mimeType === SCRIPT_MIME) {
    const response = await ctx.getDrive().files.export({ fileId, mimeType: 'application/vnd.google-apps.script+json' }, { responseType: 'text' });
    return json({ ...metadata.data, text: String(response.data ?? '') });
  }
  if (mimeType === VIDS_MIME) {
    return json({ ...metadata.data, readableText: null, hint: 'Google Vids have no text export. Use fetch(download_raw_file=true, raw_export_mime_type="video/mp4") or download_file_lro.' });
  }
  return null;
}

function safeFileName(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return basename(raw).replace(/[^A-Za-z0-9._ -]/g, '_') || fallback;
}

async function materializeProvidedFile(value: any, directory: string, index: number): Promise<Materialized> {
  if (typeof value === 'string') return { path: value, fileName: basename(value), downloaded: false };
  if (!value || typeof value !== 'object') throw new Error('Provided file argument must be a local path or provided-file object.');
  const localPath = value.path || value.file_path || value.local_path || value.uri;
  if (typeof localPath === 'string' && localPath) return { path: localPath, fileName: value.file_name || value.fileName || basename(localPath), downloaded: false };
  if (typeof value.download_url !== 'string' || !value.download_url) throw new Error('Provided-file object is missing download_url.');
  const name = safeFileName(value.file_name, `provided-${index}`);
  const path = join(directory, `${index}-${name}`);
  const response = await fetch(value.download_url);
  if (!response.ok) throw new Error(`Failed to materialize provided file ${name}: HTTP ${response.status}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return { path, fileName: name, downloaded: true };
}

function rewriteImageRequestReferences(value: unknown, materialized: Materialized[]): unknown {
  if (typeof value === 'string') {
    for (let index = 0; index < materialized.length; index++) {
      const item = materialized[index];
      if (value === `{{image_uris[${index}]}}` || value === `image_uris[${index}]`) return item.path;
      if (item.fileName) {
        const normalized = value.replace(/\\/g, '/');
        if (value === item.fileName || normalized.endsWith(`/${item.fileName}`)) return item.path;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => rewriteImageRequestReferences(item, materialized));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, rewriteImageRequestReferences(item, materialized)]));
  return value;
}

async function delegateWithProvidedFiles(toolName: string, args: Record<string, any>, ctx: ToolContext): Promise<ToolResult | null> {
  const definition: any = base.toolDefinitions.find((item: any) => item.name === toolName);
  const fileParams = definition ? fileParamsFrom(definition) : [];
  if (!fileParams.length) return base.handleTool(toolName, args, ctx);
  const directory = await mkdtemp(join(tmpdir(), 'nick-drive-provided-'));
  let index = 0;
  try {
    const rewritten: Record<string, any> = { ...args };
    for (const field of fileParams) {
      const value = args[field];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        const materialized: Materialized[] = [];
        for (const item of value) materialized.push(await materializeProvidedFile(item, directory, index++));
        rewritten[field] = materialized.map((item) => item.path);
        if (field === 'image_uris' && Array.isArray(rewritten.requests)) rewritten.requests = rewriteImageRequestReferences(rewritten.requests, materialized);
      } else {
        const materialized = await materializeProvidedFile(value, directory, index++);
        rewritten[field] = {
          ...(typeof value === 'object' ? value : {}),
          path: materialized.path,
          ...(materialized.fileName ? { file_name: materialized.fileName } : {}),
        };
      }
    }
    return await base.handleTool(toolName, rewritten, ctx);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function handleTool(toolName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  try {
    if (toolName === 'export_file') return handleExport(args as Record<string, any>, ctx);
    if (toolName === 'fetch') {
      const a = args as Record<string, any>;
      if (a.download_raw_file) return handleFetchRaw(a, ctx);
      const special = await handleReadableNative(a, ctx);
      if (special) return special;
    }
    return delegateWithProvidedFiles(toolName, args as Record<string, any>, ctx);
  } catch (error: any) {
    return errorResponse(error?.message || String(error));
  }
}
