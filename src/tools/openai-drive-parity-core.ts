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
  const rest = { ...definition };
  delete rest.fileParams;
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
  if (!value || typeof value !== 'string') throw new Error('A Drive file ID or URL is required.');
  return extractId(value);
}

function normalizeRangeLike(value: any): any {
  if (typeof value !== 'string') return value;
  return value.includes('!') ? value : `Sheet1!${value}`;
}

function maybeUrlToId(value: any): any {
  return typeof value === 'string' ? extractId(value) : value;
}

function normalizeIds(args: Record<string, any>, fields: string[]): Record<string, any> {
  const copy = { ...args };
  for (const field of fields) {
    if (copy[field] !== undefined) copy[field] = maybeUrlToId(copy[field]);
  }
  return copy;
}

function normalizeRows(rows: any): any[][] {
  if (!Array.isArray(rows)) throw new Error('rows must be an array.');
  return rows.map((row) => (Array.isArray(row) ? row : [row]));
}

function text(value: any): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

function toolText(value: any): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function nonEmpty(value: any): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function extractDownloadUrl(file: any): string | undefined {
  return file?.download_url ?? file?.downloadUrl ?? file?.url;
}

function extractProvidedFileName(file: any): string | undefined {
  return file?.file_name ?? file?.fileName ?? file?.name;
}

async function materializeProvidedFile(file: any): Promise<Materialized> {
  if (typeof file === 'string') return { path: file, fileName: basename(file), downloaded: false };
  if (!file || typeof file !== 'object') throw new Error('Expected a resolved MCP file parameter.');
  const url = extractDownloadUrl(file);
  if (!url) throw new Error('Resolved MCP file parameter is missing download_url.');
  const dir = await mkdtemp(join(tmpdir(), 'gdrive-mcp-openai-file-'));
  const fileName = extractProvidedFileName(file) || 'upload.bin';
  const path = join(dir, basename(fileName));
  const response = await fetch(url);
  if (!response.ok) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`Failed to download supplied MCP file (${response.status}).`);
  }
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return { path, fileName, downloaded: true };
}

async function cleanupMaterialized(value: Materialized | undefined): Promise<void> {
  if (!value?.downloaded) return;
  await rm(join(value.path, '..'), { recursive: true, force: true });
}

async function callBase(name: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
  return base.handleToolCall(name, args, context);
}

async function withMaterializedFile(
  file: any,
  fn: (materialized: Materialized) => Promise<ToolResult>,
): Promise<ToolResult> {
  let materialized: Materialized | undefined;
  try {
    materialized = await materializeProvidedFile(file);
    return await fn(materialized);
  } finally {
    await cleanupMaterialized(materialized);
  }
}

async function handleImport(name: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
  const file = args.file;
  return withMaterializedFile(file, async (materialized) => {
    const map: Record<string, string> = {
      import_document: 'uploadFile',
      import_spreadsheet: 'uploadFile',
      import_presentation: 'uploadFile',
    };
    const inferredName = args.name || materialized.fileName;
    return callBase(map[name], {
      localPath: materialized.path,
      name: inferredName,
      parentFolderId: args.parent_folder_id,
      convertToGoogleFormat: true,
    }, context);
  });
}

async function handleUploadFile(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
  const file = args.file;
  return withMaterializedFile(file, async (materialized) => callBase('uploadFile', {
    localPath: materialized.path,
    name: args.name || materialized.fileName,
    parentFolderId: args.parent_folder_id,
    mimeType: args.mime_type,
  }, context));
}

async function handleUpdateFile(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
  const id = pickId(args);
  if (args.file) {
    return withMaterializedFile(args.file, async (materialized) => callBase('uploadFile', {
      fileId: id,
      localPath: materialized.path,
      name: args.name || materialized.fileName,
      mimeType: args.mime_type,
    }, context));
  }
  if (args.name) return callBase('renameItem', { itemId: id, newName: args.name }, context);
  if (args.parent_folder_id) return callBase('moveItem', { itemId: id, newParentId: maybeUrlToId(args.parent_folder_id) }, context);
  throw new Error('update_file requires a file payload, name, or parent_folder_id.');
}

async function handleCreateFile(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
  if (args.file) return handleUploadFile(args, context);
  if (typeof args.content === 'string') {
    return callBase('createTextFile', {
      name: args.name,
      content: args.content,
      parentFolderId: args.parent_folder_id,
      mimeType: args.mime_type || 'text/plain',
    }, context);
  }
  throw new Error('create_file requires file or content.');
}

async function handleComments(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
  const id = pickId(args);
  return callBase('listComments', { documentId: id, pageSize: args.page_size, pageToken: args.page_token }, context);
}

async function handleGeneric(name: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
  switch (name) {
    case 'copy_file':
      return callBase('copyFile', { fileId: pickId(args), name: args.name, parentFolderId: args.parent_folder_id }, context);
    case 'create_folder':
      return callBase('createFolder', { name: args.name, parentFolderId: args.parent_folder_id }, context);
    case 'delete_file':
      if (!args.confirm) throw new Error('Permanent delete requires confirm=true.');
      return (context as any).drive.files.delete({ fileId: pickId(args), supportsAllDrives: true }).then(() => toolText('File permanently deleted.'));
    case 'export_file':
      return callBase('downloadFile', { fileId: pickId(args), localPath: args.local_path, exportMimeType: args.mime_type, overwrite: args.overwrite }, context);
    case 'fetch':
      return callBase('read_file_content', { file_id: pickId(args), as_text: true }, context);
    case 'fetch_file_revision':
      return callBase('manage_file_revision', { action: 'download', file_id: pickId(args), revision_id: args.revision_id }, context);
    case 'get_file_metadata':
      return callBase('get_file_metadata', { file_id: pickId(args), fields: args.fields }, context);
    case 'list_file_revisions':
      return callBase('getRevisions', { fileId: pickId(args), pageSize: args.page_size, pageToken: args.page_token }, context);
    case 'list_folder':
      return callBase('listFolder', { folderId: pickId(args), pageSize: args.page_size, pageToken: args.page_token }, context);
    case 'recent_documents':
      return callBase('list_recent_files', { page_size: args.page_size, order_by: args.order_by }, context);
    case 'share_file':
      return callBase('shareFile', { fileId: pickId(args), emailAddress: args.email_address, role: args.role }, context);
    case 'list_drives':
      return callBase('listSharedDrives', { pageSize: args.page_size, pageToken: args.page_token }, context);
    case 'get_file_comments':
    case 'get_document_comments':
    case 'get_spreadsheet_comments':
    case 'get_presentation_comments':
      return handleComments(args, context);
    case 'get_profile': {
      const about = await (context as any).drive.about.get({ fields: 'user,storageQuota' });
      return toolText(about.data);
    }
    default:
      break;
  }
  throw new Error(`No OpenAI parity implementation for ${name}.`);
}

async function handleDocument(name: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
  const id = pickId(args);
  switch (name) {
    case 'batch_update_document': {
      const response = await (context as any).docs.documents.batchUpdate({ documentId: id, requestBody: { requests: args.requests || [] } });
      return toolText(response.data);
    }
    case 'get_document':
      return callBase('readGoogleDoc', { documentId: id, format: args.format || 'markdown' }, context);
    case 'get_document_text':
      return callBase('readGoogleDoc', { documentId: id, format: 'text', tabId: args.tab_id }, context);
    case 'find_document_text_range':
      return callBase('getGoogleDocContent', { documentId: id }, context).then((result) => {
        const rendered = result.content?.map((item: any) => item.text || '').join('\n') || '';
        const needle = text(args.text);
        const index = rendered.indexOf(needle);
        return toolText(index < 0 ? { found: false } : { found: true, start_index: index + 1, end_index: index + needle.length + 1 });
      });
    case 'get_document_paragraph_range':
      return callBase('getGoogleDocContent', { documentId: id }, context);
    case 'get_document_tables':
      return callBase('getGoogleDocContent', { documentId: id, includeFormatting: true }, context);
    default:
      return handleGeneric(name, args, context);
  }
}

async function handleSpreadsheet(name: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
  const id = pickId(args);
  switch (name) {
    case 'batch_update_spreadsheet': {
      const response = await (context as any).sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: args.requests || [], includeSpreadsheetInResponse: args.include_spreadsheet_in_response } });
      return toolText(response.data);
    }
    case 'get_spreadsheet_metadata':
      return callBase('getSpreadsheetInfo', { spreadsheetId: id }, context);
    case 'get_spreadsheet_range':
      return callBase('getGoogleSheetContent', { spreadsheetId: id, range: normalizeRangeLike(args.range), valueRenderOption: args.value_render_option }, context);
    case 'get_spreadsheet_cells': {
      const response = await (context as any).sheets.spreadsheets.get({ spreadsheetId: id, ranges: args.ranges, includeGridData: true });
      return toolText(response.data);
    }
    case 'search_spreadsheet_rows': {
      const range = normalizeRangeLike(args.range || 'A:ZZ');
      const response = await (context as any).sheets.spreadsheets.values.get({ spreadsheetId: id, range, valueRenderOption: args.value_render_option });
      const query = text(args.query).toLowerCase();
      const rows = normalizeRows(response.data.values || []);
      const matches = rows.map((row, index) => ({ row_number: index + 1, values: row })).filter((row) => row.values.some((cell) => text(cell).toLowerCase().includes(query)));
      return toolText({ matches, count: matches.length });
    }
    case 'duplicate_sheet_in_new_spreadsheet': {
      const sourceSheetId = Number(args.sheet_id);
      const create = await (context as any).sheets.spreadsheets.create({ requestBody: { properties: { title: args.title || 'Copy' } } });
      const destinationSpreadsheetId = create.data.spreadsheetId;
      const response = await (context as any).sheets.spreadsheets.sheets.copyTo({ spreadsheetId: id, sheetId: sourceSheetId, requestBody: { destinationSpreadsheetId } });
      return toolText({ spreadsheet: create.data, copied_sheet: response.data });
    }
    default:
      return handleGeneric(name, args, context);
  }
}

async function handlePresentation(name: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
  const id = pickId(args);
  switch (name) {
    case 'batch_update_presentation': {
      const response = await (context as any).slides.presentations.batchUpdate({ presentationId: id, requestBody: { requests: args.requests || [] } });
      return toolText(response.data);
    }
    case 'get_presentation':
      return callBase('getGoogleSlidesContent', { presentationId: id }, context);
    case 'get_presentation_text':
    case 'get_presentation_outline':
    case 'get_presentation_tables':
      return callBase('getGoogleSlidesContent', { presentationId: id }, context);
    case 'get_slide': {
      const response = await (context as any).slides.presentations.pages.get({ presentationId: id, pageObjectId: args.slide_id });
      return toolText(response.data);
    }
    case 'get_slide_thumbnail':
      return callBase('exportSlideThumbnail', { presentationId: id, pageObjectId: args.slide_id, mimeType: args.mime_type, scale: args.scale }, context);
    case 'create_presentation_from_template': {
      const copied = await (context as any).drive.files.copy({ fileId: id, requestBody: { name: args.name, parents: args.parent_folder_id ? [maybeUrlToId(args.parent_folder_id)] : undefined }, supportsAllDrives: true });
      return toolText(copied.data);
    }
    default:
      return handleGeneric(name, args, context);
  }
}

async function handleBulkComments(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
  const id = pickId(args);
  const actions = Array.isArray(args.actions) ? args.actions : [];
  const results: any[] = [];
  for (const action of actions) {
    const type = action.action || action.type;
    if (type === 'create') {
      const response = await (context as any).drive.comments.create({ fileId: id, fields: '*', requestBody: { content: action.content } });
      results.push(response.data);
    } else if (type === 'reply') {
      const response = await (context as any).drive.replies.create({ fileId: id, commentId: action.comment_id, fields: '*', requestBody: { content: action.content } });
      results.push(response.data);
    } else if (type === 'resolve') {
      const response = await (context as any).drive.replies.create({ fileId: id, commentId: action.comment_id, fields: '*', requestBody: { action: 'resolve' } });
      results.push(response.data);
    } else {
      throw new Error(`Unsupported comment action: ${type}`);
    }
  }
  return toolText({ results });
}

export async function handleToolCall(name: string, args: any, context: ToolContext): Promise<ToolResult> {
  try {
    const normalized = normalizeIds(args || {}, ['id', 'url', 'file_id', 'document_id', 'spreadsheet_id', 'presentation_id', 'template_id', 'parent_folder_id']);
    switch (name) {
      case 'import_document':
      case 'import_spreadsheet':
      case 'import_presentation':
        return handleImport(name, normalized, context);
      case 'upload_file':
        return handleUploadFile(normalized, context);
      case 'update_file':
        return handleUpdateFile(normalized, context);
      case 'create_file':
        return handleCreateFile(normalized, context);
      case 'bulk_update_file_comments':
        return handleBulkComments(normalized, context);
      case 'batch_update_document':
      case 'get_document':
      case 'get_document_text':
      case 'find_document_text_range':
      case 'get_document_paragraph_range':
      case 'get_document_tables':
        return handleDocument(name, normalized, context);
      case 'batch_update_spreadsheet':
      case 'get_spreadsheet_metadata':
      case 'get_spreadsheet_range':
      case 'get_spreadsheet_cells':
      case 'search_spreadsheet_rows':
      case 'duplicate_sheet_in_new_spreadsheet':
        return handleSpreadsheet(name, normalized, context);
      case 'batch_update_presentation':
      case 'get_presentation':
      case 'get_presentation_text':
      case 'get_presentation_outline':
      case 'get_presentation_tables':
      case 'get_slide':
      case 'get_slide_thumbnail':
      case 'create_presentation_from_template':
        return handlePresentation(name, normalized, context);
      default:
        return handleGeneric(name, normalized, context);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
