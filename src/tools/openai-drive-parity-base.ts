import { createReadStream, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { errorResponse } from '../types.js';
import { uploadImageToDrive, deleteDriveFile } from '../utils/driveImageUpload.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const SLIDES_MIME = 'application/vnd.google-apps.presentation';
const VIDS_MIME = 'application/vnd.google-apps.vid';

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation', '.rtf': 'application/rtf', '.html': 'text/html', '.htm': 'text/html',
};

const FileParamSchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().optional(), file_path: z.string().optional(), local_path: z.string().optional(),
    uri: z.string().optional(), name: z.string().optional(), filename: z.string().optional(),
    mime_type: z.string().optional(), mimeType: z.string().optional(),
  }).passthrough(),
]);

type LocalFile = { path: string; name: string; mimeType: string };
type ImageSidecar = { sourceKey: string; fileId: string; url: string };

function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }], isError: false };
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function extractId(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('A Drive file ID or URL is required.');
  if (!/^https?:\/\//i.test(raw)) return raw;
  const patterns = [/\/d\/([A-Za-z0-9_-]+)/, /\/folders\/([A-Za-z0-9_-]+)/, /[?&]id=([A-Za-z0-9_-]+)/];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return match[1];
  }
  throw new Error(`Could not extract a Google Drive ID from URL: ${raw}`);
}

function pickId(args: Record<string, any>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return extractId(value);
  }
  throw new Error(`One of ${keys.join(', ')} is required.`);
}

function folderId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'root') return 'root';
  if (typeof value !== 'string') throw new Error('Folder reference must be a folder ID, URL, or root.');
  return extractId(value);
}

function localFile(value: unknown, fallbackName?: string, fallbackMime?: string): LocalFile {
  const parsed = FileParamSchema.safeParse(value);
  if (!parsed.success) throw new Error('Expected a resolved MCP file parameter.');
  if (typeof parsed.data === 'string') {
    let path = parsed.data;
    if (path.startsWith('file://')) path = fileURLToPath(path);
    if (!existsSync(path)) throw new Error(`Resolved file does not exist on the MCP server: ${path}`);
    const name = fallbackName || basename(path);
    return { path, name, mimeType: fallbackMime || MIME_BY_EXT[extname(name).toLowerCase()] || 'application/octet-stream' };
  }
  const valueObj: any = parsed.data;
  let path = valueObj.path || valueObj.file_path || valueObj.local_path || valueObj.uri;
  if (typeof path !== 'string' || !path) throw new Error('Resolved file parameter has no local path.');
  if (path.startsWith('file://')) path = fileURLToPath(path);
  if (!existsSync(path)) throw new Error(`Resolved file does not exist on the MCP server: ${path}`);
  const name = fallbackName || valueObj.name || valueObj.filename || basename(path);
  return { path, name, mimeType: fallbackMime || valueObj.mime_type || valueObj.mimeType || MIME_BY_EXT[extname(name).toLowerCase()] || 'application/octet-stream' };
}

function textResource(uri: string, mimeType: string, text: string): any {
  return { content: [{ type: 'resource', resource: { uri, mimeType, text } }], isError: false };
}

function blobResource(uri: string, mimeType: string, data: Buffer): any {
  return { content: [{ type: 'resource', resource: { uri, mimeType, blob: data.toString('base64') } }], isError: false };
}

function imageAndMetadata(image: Buffer, mimeType: string, metadata: unknown): any {
  return { content: [{ type: 'text', text: JSON.stringify(metadata, null, 2) }, { type: 'image', data: image.toString('base64'), mimeType }], isError: false };
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(JSON.stringify(data ?? null), 'utf8');
}

function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || /json|xml|javascript|csv|markdown/i.test(mimeType);
}

async function readableOfficeText(buffer: Buffer, mimeType: string): Promise<string | null> {
  if (!/wordprocessingml|spreadsheetml|presentationml/.test(mimeType)) return null;
  const zip = await JSZip.loadAsync(buffer);
  if (mimeType.includes('wordprocessingml')) {
    const file = zip.file('word/document.xml');
    if (!file) return null;
    let xml = await file.async('string');
    xml = xml.replace(/<w:tab\/?\s*>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, '\t');
    return decodeXml(xml.replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
  }
  if (mimeType.includes('presentationml')) {
    const names = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] ?? 0) - Number(b.match(/slide(\d+)/)?.[1] ?? 0));
    const slides: string[] = [];
    for (const name of names) {
      const xml = await zip.file(name)!.async('string');
      const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1])).join(' ');
      slides.push(`Slide ${slides.length + 1}: ${text}`);
    }
    return slides.join('\n\n').trim();
  }
  if (mimeType.includes('spreadsheetml')) {
    const sharedFile = zip.file('xl/sharedStrings.xml');
    const shared: string[] = [];
    if (sharedFile) {
      const xml = await sharedFile.async('string');
      for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join(''));
    }
    const names = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort();
    const sheets: string[] = [];
    for (const name of names) {
      const xml = await zip.file(name)!.async('string');
      const rows: string[] = [];
      for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells: string[] = [];
        for (const cell of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
          const attrs = cell[1]; const raw = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
          cells.push(/t="s"/.test(attrs) ? (shared[Number(raw)] ?? '') : decodeXml(raw));
        }
        rows.push(cells.join('\t'));
      }
      sheets.push(`Sheet ${sheets.length + 1}\n${rows.join('\n')}`);
    }
    return sheets.join('\n\n').trim();
  }
  return null;
}

function docGroups(document: any, tabId?: string): Array<{ tabId?: string; content: any[] }> {
  const out: Array<{ tabId?: string; content: any[] }> = [];
  const visit = (tabs: any[] | undefined) => {
    for (const tab of tabs ?? []) {
      const id = tab?.tabProperties?.tabId;
      if (!tabId || id === tabId) out.push({ tabId: id, content: tab?.documentTab?.body?.content ?? [] });
      visit(tab?.childTabs);
    }
  };
  if (document?.tabs?.length) visit(document.tabs);
  else if (!tabId) out.push({ content: document?.body?.content ?? [] });
  return out;
}

function paragraphText(paragraph: any): string {
  return (paragraph?.elements ?? []).map((element: any) => element?.textRun?.content ?? element?.person?.personProperties?.name ?? '').join('');
}

function docTextRecords(document: any, tabId?: string): any[] {
  const records: any[] = [];
  for (const group of docGroups(document, tabId)) for (const block of group.content) if (block?.paragraph) records.push({ ...(group.tabId ? { tabId: group.tabId } : {}), startIndex: block.startIndex, endIndex: block.endIndex, text: paragraphText(block.paragraph) });
  return records;
}

function findDocText(document: any, needle: string, instance: number, tabId?: string): any | null {
  let seen = 0;
  for (const group of docGroups(document, tabId)) {
    for (const block of group.content) {
      if (!block?.paragraph) continue;
      const text = paragraphText(block.paragraph); let offset = -1; let from = 0;
      while ((offset = text.indexOf(needle, from)) >= 0) {
        seen += 1;
        if (seen === instance) { const start = Number(block.startIndex ?? 0) + offset; return { startIndex: start, endIndex: start + needle.length, ...(group.tabId ? { tabId: group.tabId } : {}) }; }
        from = offset + Math.max(1, needle.length);
      }
    }
  }
  return null;
}

function extractDocTables(document: any, tabId?: string): any[] {
  const tables: any[] = [];
  for (const group of docGroups(document, tabId)) for (const block of group.content) if (block?.table?.tableRows) tables.push({ ...(group.tabId ? { tabId: group.tabId } : {}), startIndex: block.startIndex, endIndex: block.endIndex, rows: block.table.tableRows.map((row: any) => (row?.tableCells ?? []).map((cell: any) => (cell?.content ?? []).map((part: any) => paragraphText(part?.paragraph)).join('').replace(/\n+$/g, ''))) });
  return tables;
}

function slideTextFromElements(elements: any[] | undefined): string {
  const chunks: string[] = [];
  for (const element of elements ?? []) {
    const shape = (element?.shape?.text?.textElements ?? []).map((part: any) => part?.textRun?.content ?? '').join('').trimEnd();
    if (shape) chunks.push(shape);
    for (const row of element?.table?.tableRows ?? []) chunks.push((row?.tableCells ?? []).map((cell: any) => (cell?.text?.textElements ?? []).map((part: any) => part?.textRun?.content ?? '').join('').trimEnd()).join('\t'));
  }
  return chunks.join('\n');
}

function presentationOutline(presentation: any): any {
  return { presentationId: presentation.presentationId, title: presentation.title, revisionId: presentation.revisionId, slides: (presentation.slides ?? []).map((slide: any, index: number) => ({ slideNumber: index + 1, objectId: slide.objectId, text: slideTextFromElements(slide.pageElements) })) };
}

function presentationTables(presentation: any): any[] {
  const tables: any[] = [];
  (presentation.slides ?? []).forEach((slide: any, slideIndex: number) => {
    for (const element of slide?.pageElements ?? []) if (element?.table) tables.push({ slideNumber: slideIndex + 1, slideObjectId: slide.objectId, tableObjectId: element.objectId, rows: (element.table.tableRows ?? []).map((row: any, rowIndex: number) => (row?.tableCells ?? []).map((cell: any, columnIndex: number) => ({ rowIndex, columnIndex, text: (cell?.text?.textElements ?? []).map((part: any) => part?.textRun?.content ?? '').join('').trimEnd() }))) });
  });
  return tables;
}

function quoteSheetName(name: string): string { return `'${name.replace(/'/g, "''")}'`; }
function columnIndex(letter: string): number { let value = 0; for (const c of letter.toUpperCase()) value = value * 26 + c.charCodeAt(0) - 64; return value; }
function columnLetter(value: number): string { let result = ''; let current = value; while (current > 0) { current -= 1; result = String.fromCharCode(65 + (current % 26)) + result; current = Math.floor(current / 26); } return result; }

async function driveComments(ctx: ToolContext, fileId: string, args: any): Promise<ToolResult> {
  const response = await ctx.getDrive().comments.list({ fileId, fields: 'nextPageToken,comments(id,content,anchor,quotedFileContent,resolved,author,createdTime,modifiedTime,replies(id,content,action,author,createdTime,modifiedTime,deleted))', includeDeleted: args.include_deleted ?? false, pageSize: Math.min(Math.max(Number(args.page_size ?? 100), 1), 100), pageToken: args.page_token ?? undefined });
  return json(response.data);
}

async function ensureDownloadable(ctx: ToolContext, fileId: string): Promise<any> {
  const metadata = await ctx.getDrive().files.get({ fileId, fields: 'id,name,mimeType,size,resourceKey,capabilities(canDownload)', supportsAllDrives: true });
  if (metadata.data.capabilities?.canDownload === false) throw new Error('Google Drive reports capabilities.canDownload=false for this file.');
  return metadata.data;
}

function fileParamDef(name: string, description: string, properties: any, required: string[], fileParams: string[]): any { return { name, description, inputSchema: { type: 'object', properties, required }, fileParams }; }
function def(name: string, description: string, properties: any = {}, required: string[] = []): ToolDefinition { return { name, description, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) } }; }

const idOrUrl = { id: { type: 'string' }, url: { type: 'string' } };
const docRef = { document_id: { type: 'string' }, document_url: { type: 'string' } };
const sheetRef = { spreadsheet_id: { type: 'string' }, spreadsheet_url: { type: 'string' } };
const presentationRef = { presentation_id: { type: 'string' }, presentation_url: { type: 'string' } };

export const toolDefinitions: ToolDefinition[] = [
  fileParamDef('batch_update_document', 'Apply raw Google Docs documents.batchUpdate requests.', { ...docRef, requests: { type: 'array', items: { type: 'object' }, minItems: 1 }, write_control: { type: 'object' }, image_uris: { type: 'array', items: {} } }, ['requests'], ['image_uris']),
  fileParamDef('batch_update_presentation', 'Apply raw Google Slides presentations.batchUpdate requests.', { ...presentationRef, requests: { type: 'array', items: { type: 'object' }, minItems: 1 }, write_control: { type: 'object' }, image_uris: { type: 'array', items: {} } }, ['requests'], ['image_uris']),
  fileParamDef('batch_update_spreadsheet', 'Apply raw Google Sheets spreadsheets.batchUpdate requests.', { ...sheetRef, requests: { type: 'array', items: { type: 'object' }, minItems: 1 }, include_spreadsheet_in_response: { type: 'boolean' }, response_ranges: { type: 'array', items: { type: 'string' } }, response_include_grid_data: { type: 'boolean' }, image_uris: { type: 'array', items: {} } }, ['requests'], ['image_uris']),
  def('bulk_update_file_comments', 'Create, reply to, and resolve Drive comments in one bounded call.', { ...idOrUrl, comments: { type: 'array', maxItems: 20, items: { type: 'object' } }, replies: { type: 'array', maxItems: 20, items: { type: 'object' } }, resolutions: { type: 'array', maxItems: 20, items: { type: 'object' } } }),
  def('copy_file', 'Copy a Drive file and return the new copy metadata.', { url: { type: 'string' }, new_title: { type: 'string' }, parent_folder: { type: 'string' } }, ['url']),
  def('create_file', 'Create a blank native Google Doc, Sheet, or Slides file.', { title: { type: 'string' }, mime_type: { type: 'string', enum: [DOC_MIME, SHEET_MIME, SLIDES_MIME] } }, ['title', 'mime_type']),
  def('create_folder', 'Create a Drive folder.', { name: { type: 'string' }, parent_folder: { type: 'string' } }, ['name']),
  def('create_presentation_from_template', 'Copy an existing native Google Slides deck.', { template_presentation_id: { type: 'string' }, template_presentation_url: { type: 'string' }, title: { type: 'string' } }),
  def('delete_file', 'Permanently delete a Drive file.', { url: { type: 'string' }, id: { type: 'string' } }),
  def('duplicate_sheet_in_new_spreadsheet', 'Copy one sheet tab into a newly created spreadsheet.', { ...sheetRef, source_sheet_name: { type: 'string' }, new_file_name: { type: 'string' }, new_sheet_name: { type: 'string' } }, ['source_sheet_name', 'new_file_name']),
  def('export_file', 'Export a native Workspace file with Drive files.export.', { ...idOrUrl, mime_type: { type: 'string', default: 'application/pdf' } }),
  def('fetch', 'Read a Drive file, folder, or raw file bytes.', { url: { type: 'string' }, download_raw_file: { type: 'boolean', default: false }, raw_export_mime_type: { type: ['string', 'null'] }, include_base64: { type: ['boolean', 'null'] } }, ['url']),
  def('fetch_file_revision', 'Fetch one Drive revision including readable content when supported.', { fileId: { type: 'string' }, revisionId: { type: 'string' }, exportMimeType: { type: 'string', default: 'text/plain' }, acknowledgeAbuse: { type: 'boolean' } }, ['fileId', 'revisionId']),
  def('find_document_text_range', 'Find the indexed range of an exact Docs text occurrence.', { ...docRef, text_to_find: { type: 'string' }, instance: { type: 'integer', minimum: 1, default: 1 }, tab_id: { type: 'string' } }, ['text_to_find']),
  def('get_document', 'Return a native Google Docs resource.', { ...docRef, fields: { type: 'string' } }),
  def('get_document_comments', 'Read Drive comments on a Google Doc.', { ...docRef, include_deleted: { type: 'boolean' }, page_size: { type: 'integer' }, page_token: { type: 'string' } }),
  def('get_document_paragraph_range', 'Resolve the paragraph containing a Docs index.', { ...docRef, index_within: { type: 'integer' }, tab_id: { type: 'string' } }, ['index_within']),
  def('get_document_tables', 'Return table structures from a Google Doc.', { ...docRef, tab_id: { type: 'string' } }),
  def('get_document_text', 'Return Docs text with stable index ranges.', { ...docRef, tab_id: { type: 'string' } }),
  def('get_file_comments', 'Read comments on an arbitrary Drive file.', { ...idOrUrl, include_deleted: { type: 'boolean' }, page_size: { type: 'integer' }, page_token: { type: 'string' } }),
  def('get_file_metadata', 'Return Drive files.get metadata.', { fileId: { type: 'string' }, acknowledgeAbuse: { type: 'boolean' }, supportsAllDrives: { type: 'boolean' }, supportsTeamDrives: { type: 'boolean' }, includePermissionsForView: { type: 'string' }, includeLabels: { type: 'string' }, fields: { type: 'string' } }, ['fileId']),
  def('get_presentation', 'Return a native Google Slides presentation.', { ...presentationRef, fields: { type: 'string' } }),
  def('get_presentation_comments', 'Read Drive comments on a Slides deck.', { ...presentationRef, include_deleted: { type: 'boolean' }, page_size: { type: 'integer' }, page_token: { type: 'string' } }),
  def('get_presentation_outline', 'Return a compact slide outline with stable object IDs.', { ...presentationRef }),
  def('get_presentation_tables', 'Return Slides tables with coordinates.', { ...presentationRef }),
  def('get_presentation_text', 'Return readable text from a Slides deck.', { ...presentationRef }),
  def('get_profile', 'Return the active Drive user profile and storage quota.'),
  def('get_slide', 'Return one slide by object ID.', { ...presentationRef, slide_object_id: { type: 'string' } }, ['slide_object_id']),
  def('get_slide_thumbnail', 'Return slide metadata plus an inline thumbnail image.', { ...presentationRef, slide_object_id: { type: 'string' }, thumbnail_size: { type: 'string', enum: ['SMALL', 'MEDIUM', 'LARGE'], default: 'MEDIUM' } }, ['slide_object_id']),
  def('get_spreadsheet_cells', 'Read bounded Sheets CellData.', { ...sheetRef, ranges: { type: 'array', items: { type: 'string' }, minItems: 1 }, cell_fields: { type: 'string' } }, ['ranges']),
  def('get_spreadsheet_comments', 'Read Drive comments on a spreadsheet.', { ...sheetRef, include_deleted: { type: 'boolean' }, page_size: { type: 'integer' }, page_token: { type: 'string' } }),
  def('get_spreadsheet_metadata', 'Return native spreadsheet metadata.', { ...sheetRef, charts_only: { type: 'boolean' }, include_conditional_format_rules: { type: 'boolean' } }),
  def('get_spreadsheet_range', 'Read plain values from a Sheets range.', { ...sheetRef, sheet_name: { type: ['string', 'null'] }, range: { type: 'string' }, value_render_option: { type: ['string', 'null'], enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA', null] } }, ['range']),
  fileParamDef('import_document', 'Import a local document to Drive, defaulting to native Google Docs.', { source_file: {}, title: { type: 'string' }, upload_mode: { type: 'string', enum: ['native_google_docs', 'keep_source_file_type'] } }, ['source_file'], ['source_file']),
  fileParamDef('import_presentation', 'Import a local presentation to Drive, defaulting to native Google Slides.', { source_file: {}, title: { type: 'string' }, upload_mode: { type: 'string', enum: ['native_google_slides', 'keep_source_file_type'] } }, ['source_file'], ['source_file']),
  fileParamDef('import_spreadsheet', 'Import a local spreadsheet to Drive, defaulting to native Google Sheets.', { source_file: {}, title: { type: 'string' }, upload_mode: { type: 'string', enum: ['native_google_sheets', 'keep_source_file_type'] } }, ['source_file'], ['source_file']),
  def('list_drives', 'List Shared Drives accessible to the user.'),
  def('list_file_revisions', 'List Drive revisions with previousRevisionId links.', { fileId: { type: 'string' }, pageSize: { type: 'integer' }, pageToken: { type: 'string' } }, ['fileId']),
  def('list_folder', 'List direct children of a Drive folder.', { url: { type: 'string' }, top_k: { type: 'integer', minimum: 1, maximum: 100, default: 100 } }, ['url']),
  def('recent_documents', 'Return most recently modified Drive items.', { top_k: { type: 'integer', minimum: 1, maximum: 100 }, require_viewed_by_user: { type: 'boolean' } }, ['top_k']),
  def('search_spreadsheet_rows', 'Search a finite bounded spreadsheet range.', { ...sheetRef, sheet_name: { type: ['string', 'null'] }, query: { type: 'string' }, start_row: { type: 'integer', default: 1 }, end_row: { type: ['integer', 'null'] }, start_column: { type: 'string', default: 'A' }, end_column: { type: ['string', 'null'] }, range: { type: ['string', 'null'] }, return_columns: { type: ['array', 'null'], items: { type: 'string' } }, column_numbers: { type: ['array', 'null'], items: { type: 'integer' } }, header_row: { type: ['integer', 'null'], default: 1 }, include_header_row: { type: 'boolean', default: true }, max_matching_rows: { type: 'integer', default: 100 }, max_rows: { type: ['integer', 'null'] }, max_columns: { type: 'integer', default: 100 } }, ['query']),
  def('share_file', 'Share a Drive file with a user or Workspace domain.', { url: { type: 'string' }, permission: { type: 'string', enum: ['reader', 'writer', 'commenter', 'owner'] }, user_email: { type: ['string', 'null'] }, anyone_at_company: { type: 'boolean', default: false }, show_in_search: { type: 'boolean', default: false } }, ['url', 'permission']),
  fileParamDef('update_file', 'Update Drive metadata/parents and optionally replace raw file bytes in-place.', { fileId: { type: 'string' }, name: { type: ['string', 'null'] }, addParents: { type: ['string', 'null'] }, removeParents: { type: ['string', 'null'] }, file_uri: {}, mime_type: { type: ['string', 'null'] } }, ['fileId'], ['file_uri']),
  fileParamDef('upload_file', 'Upload a new raw Drive file.', { file_uri: {}, parent_folder_id: { type: ['string', 'null'] }, file_name: { type: ['string', 'null'] }, mime_type: { type: ['string', 'null'] } }, ['file_uri'], ['file_uri']),
  def('download_file_lro', 'Start a Drive files.download long-running operation. Supports Google Vids and large native exports beyond files.export limits.', { file_id: { type: 'string' }, url: { type: 'string' }, mime_type: { type: 'string' }, revision_id: { type: 'string' }, poll_attempts: { type: 'integer', minimum: 0, maximum: 10, default: 0 }, embed_result: { type: 'boolean', default: false }, max_embed_bytes: { type: 'integer', minimum: 1, maximum: 52428800, default: 10485760 } }),
  def('get_download_operation', 'Poll a Drive files.download long-running operation.', { operation_name: { type: 'string' }, embed_result: { type: 'boolean', default: false }, max_embed_bytes: { type: 'integer', minimum: 1, maximum: 52428800, default: 10485760 } }, ['operation_name']),
  def('generate_drive_ids', 'Pre-generate Drive file IDs for advanced transactional workflows.', { count: { type: 'integer', minimum: 1, maximum: 100, default: 10 } }),
  def('empty_trash', 'Permanently empty My Drive trash. Requires confirm=true.', { confirm: { type: 'boolean' } }, ['confirm']),
];

async function prepareImageSidecars(ctx: ToolContext, requests: any[], values: unknown): Promise<{ requests: any[]; sidecars: ImageSidecar[] }> {
  if (!Array.isArray(values) || values.length === 0) return { requests, sidecars: [] };
  const sidecars: ImageSidecar[] = [];
  try {
    for (const value of values) {
      const file = localFile(value);
      const uploaded = await uploadImageToDrive(ctx, file.path, { makePublic: true });
      const sourceKey = typeof value === 'string' ? value : (value as any).path || (value as any).file_path || (value as any).local_path || (value as any).uri || file.path;
      sidecars.push({ sourceKey, fileId: uploaded.fileId, url: uploaded.webContentLink });
    }
  } catch (error) {
    await Promise.all(sidecars.map((sidecar) => deleteDriveFile(ctx, sidecar.fileId).catch(() => {})));
    throw error;
  }
  const replace = (input: any): any => {
    if (typeof input === 'string') {
      let output = input;
      for (const sidecar of sidecars) output = output.split(sidecar.sourceKey).join(sidecar.url);
      return output;
    }
    if (Array.isArray(input)) return input.map(replace);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, replace(item)]));
    return input;
  };
  return { requests: replace(requests), sidecars };
}

async function cleanupSidecars(ctx: ToolContext, sidecars: ImageSidecar[]): Promise<void> {
  await Promise.all(sidecars.map((sidecar) => deleteDriveFile(ctx, sidecar.fileId).catch(() => {})));
}

async function importFile(ctx: ToolContext, value: unknown, title: string | undefined, uploadMode: string | undefined, nativeMime: string): Promise<ToolResult> {
  const file = localFile(value);
  const native = !uploadMode || uploadMode.startsWith('native_');
  const requestBody: any = { name: title || basename(file.name, extname(file.name)), mimeType: native ? nativeMime : file.mimeType };
  const response = await ctx.getDrive().files.create({ requestBody, media: { mimeType: file.mimeType, body: createReadStream(file.path) }, fields: 'id,name,mimeType,webViewLink,parents', supportsAllDrives: true });
  return json(response.data);
}

async function maybeEmbedDownload(ctx: ToolContext, operation: any, embedResult: boolean, maxBytes: number, fallbackName?: string, fallbackMime?: string): Promise<ToolResult> {
  if (!operation?.done || !operation?.response?.downloadUri || !embedResult) return json(operation);
  const response = await ctx.authClient.request({ url: operation.response.downloadUri, responseType: 'arraybuffer' });
  const data = toBuffer(response.data);
  if (data.length > maxBytes) return json({ ...operation, embedded: false, reason: `download is ${data.length} bytes, above max_embed_bytes=${maxBytes}` });
  return blobResource(`gdrive-download:///${encodeURIComponent(fallbackName || 'download')}`, fallbackMime || 'application/octet-stream', data);
}

async function startDownloadOperation(ctx: ToolContext, args: any): Promise<ToolResult> {
  const fileId = pickId(args, 'file_id', 'url');
  const metadata = await ensureDownloadable(ctx, fileId);
  const params: any = {};
  if (args.mime_type) params.mimeType = args.mime_type;
  if (args.revision_id) params.revisionId = args.revision_id;
  const headers: any = {};
  if (metadata.resourceKey) headers['X-Goog-Drive-Resource-Keys'] = `${fileId}/${metadata.resourceKey}`;
  let operation = (await ctx.authClient.request({ url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/download`, method: 'POST', params, headers })).data;
  const attempts = Math.max(0, Math.min(Number(args.poll_attempts ?? 0), 10));
  for (let i = 0; i < attempts && !operation?.done; i++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 500 * (2 ** i))));
    operation = (await ctx.authClient.request({ url: `https://www.googleapis.com/drive/v3/${operation.name}`, method: 'GET' })).data;
  }
  return maybeEmbedDownload(ctx, { ...operation, file: metadata }, Boolean(args.embed_result), Number(args.max_embed_bytes ?? 10_485_760), metadata.name, args.mime_type || metadata.mimeType);
}

export async function handleTool(toolName: string, args: Record<string, any>, ctx: ToolContext): Promise<ToolResult | null> {
  try {
    switch (toolName) {
      case 'batch_update_document': {
        const documentId = pickId(args, 'document_id', 'document_url'); if (!Array.isArray(args.requests) || !args.requests.length) return errorResponse('requests must contain at least one operation');
        const prepared = await prepareImageSidecars(ctx, args.requests, args.image_uris);
        try { const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient }); const response = await docs.documents.batchUpdate({ documentId, requestBody: { requests: prepared.requests, ...(args.write_control ? { writeControl: args.write_control } : {}) } }); return json(response.data); }
        finally { await cleanupSidecars(ctx, prepared.sidecars); }
      }
      case 'batch_update_presentation': {
        const presentationId = pickId(args, 'presentation_id', 'presentation_url'); if (!Array.isArray(args.requests) || !args.requests.length) return errorResponse('requests must contain at least one operation');
        const prepared = await prepareImageSidecars(ctx, args.requests, args.image_uris);
        try { const slides = ctx.google.slides({ version: 'v1', auth: ctx.authClient }); const response = await slides.presentations.batchUpdate({ presentationId, requestBody: { requests: prepared.requests, ...(args.write_control ? { writeControl: args.write_control } : {}) } }); return json(response.data); }
        finally { await cleanupSidecars(ctx, prepared.sidecars); }
      }
      case 'batch_update_spreadsheet': {
        const spreadsheetId = pickId(args, 'spreadsheet_id', 'spreadsheet_url'); if (!Array.isArray(args.requests) || !args.requests.length) return errorResponse('requests must contain at least one operation');
        const prepared = await prepareImageSidecars(ctx, args.requests, args.image_uris);
        try {
          const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
          const response = await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: prepared.requests, ...(args.include_spreadsheet_in_response !== undefined ? { includeSpreadsheetInResponse: args.include_spreadsheet_in_response } : {}), ...(args.response_ranges ? { responseRanges: args.response_ranges } : {}), ...(args.response_include_grid_data !== undefined ? { responseIncludeGridData: args.response_include_grid_data } : {}) } });
          if (!prepared.sidecars.length) return json(response.data);
          return json({ ...response.data, paritySidecarFiles: prepared.sidecars.map((item) => ({ fileId: item.fileId, url: item.url, persistent: true, reason: 'Sheets IMAGE formulas may continue to reference this URL.' })) });
        } catch (error) { await cleanupSidecars(ctx, prepared.sidecars); throw error; }
      }
      case 'bulk_update_file_comments': {
        const fileId = pickId(args, 'id', 'url'); const comments = Array.isArray(args.comments) ? args.comments : []; const replies = Array.isArray(args.replies) ? args.replies : []; const resolutions = Array.isArray(args.resolutions) ? args.resolutions : [];
        if (comments.length + replies.length + resolutions.length < 1 || comments.length + replies.length + resolutions.length > 20) return errorResponse('Provide 1-20 total comment operations.');
        const drive = ctx.getDrive(); const result: any = { comments: [], replies: [], resolutions: [] };
        for (const comment of comments) { const context = [comment.quoted_text ? `quote=${JSON.stringify(comment.quoted_text)}` : '', comment.slide_number ? `slide=${comment.slide_number}` : '', comment.sheet_cell_range ? `range=${comment.sheet_cell_range}` : ''].filter(Boolean).join('; '); const content = context ? `[Context: ${context}]\n${comment.content}` : comment.content; const response = await drive.comments.create({ fileId, fields: '*', requestBody: { content, ...(comment.anchor ? { anchor: comment.anchor } : {}) } }); result.comments.push(response.data); }
        for (const reply of replies) { const response = await drive.replies.create({ fileId, commentId: reply.comment_id, fields: '*', requestBody: { content: reply.content } }); result.replies.push(response.data); }
        for (const resolution of resolutions) { const response = await drive.replies.create({ fileId, commentId: resolution.comment_id, fields: '*', requestBody: { action: 'resolve', ...(resolution.reply_content ? { content: resolution.reply_content } : {}) } }); result.resolutions.push(response.data); }
        return json(result);
      }
      case 'copy_file': { const fileId = pickId(args, 'url'); const parents = folderId(args.parent_folder); const response = await ctx.getDrive().files.copy({ fileId, requestBody: { ...(args.new_title ? { name: args.new_title } : {}), ...(parents ? { parents: [parents] } : {}) }, fields: 'id,name,mimeType,webViewLink,parents', supportsAllDrives: true }); return json(response.data); }
      case 'create_file': { if (![DOC_MIME, SHEET_MIME, SLIDES_MIME].includes(args.mime_type)) return errorResponse('mime_type must be a native Docs, Sheets, or Slides MIME type.'); const response = await ctx.getDrive().files.create({ requestBody: { name: args.title, mimeType: args.mime_type }, fields: 'id,name,mimeType,webViewLink,parents', supportsAllDrives: true }); return json(response.data); }
      case 'create_folder': { const parent = folderId(args.parent_folder); const response = await ctx.getDrive().files.create({ requestBody: { name: args.name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}) }, fields: 'id,name,mimeType,webViewLink,parents', supportsAllDrives: true }); return json(response.data); }
      case 'create_presentation_from_template': { const fileId = pickId(args, 'template_presentation_id', 'template_presentation_url'); const response = await ctx.getDrive().files.copy({ fileId, requestBody: { ...(args.title ? { name: args.title } : {}) }, fields: 'id,name,mimeType,webViewLink,parents', supportsAllDrives: true }); return json(response.data); }
      case 'delete_file': { const fileId = pickId(args, 'url', 'id'); await ctx.getDrive().files.delete({ fileId, supportsAllDrives: true }); return json({ deleted: true, permanent: true, fileId }); }
      case 'duplicate_sheet_in_new_spreadsheet': {
        const spreadsheetId = pickId(args, 'spreadsheet_id', 'spreadsheet_url'); const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient }); const source = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' }); const found = source.data.sheets?.find((sheet: any) => sheet.properties?.title === args.source_sheet_name); const sheetId = found?.properties?.sheetId;
        if (sheetId === undefined || sheetId === null) return errorResponse(`Sheet ${args.source_sheet_name} was not found.`); const created = await sheets.spreadsheets.create({ requestBody: { properties: { title: args.new_file_name } } }); const destinationSpreadsheetId = created.data.spreadsheetId!; const copied = await sheets.spreadsheets.sheets.copyTo({ spreadsheetId, sheetId, requestBody: { destinationSpreadsheetId } }); if (args.new_sheet_name && copied.data.sheetId !== undefined && copied.data.sheetId !== null) await sheets.spreadsheets.batchUpdate({ spreadsheetId: destinationSpreadsheetId, requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: copied.data.sheetId, title: args.new_sheet_name }, fields: 'title' } }] } }); return json({ spreadsheetId: destinationSpreadsheetId, url: `https://docs.google.com/spreadsheets/d/${destinationSpreadsheetId}/edit`, copiedSheetId: copied.data.sheetId });
      }
      case 'export_file': { const fileId = pickId(args, 'id', 'url'); const mimeType = args.mime_type || 'application/pdf'; await ensureDownloadable(ctx, fileId); const response = await ctx.getDrive().files.export({ fileId, mimeType }, { responseType: 'arraybuffer' }); const buffer = toBuffer(response.data); return isTextMime(mimeType) ? textResource(`gdrive-export:///${fileId}`, mimeType, buffer.toString('utf8')) : blobResource(`gdrive-export:///${fileId}`, mimeType, buffer); }
      case 'fetch': {
        const fileId = pickId(args, 'url'); const metadata = await ctx.getDrive().files.get({ fileId, fields: 'id,name,mimeType,size,parents,webViewLink,capabilities(canDownload)', supportsAllDrives: true }); const meta = metadata.data; const mime = meta.mimeType || 'application/octet-stream';
        if (mime === FOLDER_MIME) { const children = await ctx.getDrive().files.list({ q: `'${fileId}' in parents and trashed = false`, pageSize: 100, fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink)', supportsAllDrives: true, includeItemsFromAllDrives: true }); return json({ folder: meta, children: children.data.files ?? [], nextPageToken: children.data.nextPageToken ?? null, partial: Boolean(children.data.nextPageToken) }); }
        if (meta.capabilities?.canDownload === false) return errorResponse('Google Drive reports capabilities.canDownload=false for this file.');
        if (args.download_raw_file) {
          if (mime === VIDS_MIME) return errorResponse('Google Vids require Drive files.download. Use download_file_lro.');
          if (mime.startsWith('application/vnd.google-apps.')) { const exportMime = args.raw_export_mime_type || (mime === DOC_MIME ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : mime === SHEET_MIME ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation'); const response = await ctx.getDrive().files.export({ fileId, mimeType: exportMime }, { responseType: 'arraybuffer' }); const buffer = toBuffer(response.data); return isTextMime(exportMime) ? textResource(`gdrive:///${fileId}`, exportMime, buffer.toString('utf8')) : blobResource(`gdrive:///${fileId}`, exportMime, buffer); }
          const response = await ctx.getDrive().files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }); const buffer = toBuffer(response.data); return isTextMime(mime) ? textResource(`gdrive:///${fileId}`, mime, buffer.toString('utf8')) : blobResource(`gdrive:///${fileId}`, mime, buffer);
        }
        if (mime === DOC_MIME || mime === SHEET_MIME || mime === SLIDES_MIME) { const exportMime = mime === SHEET_MIME ? 'text/csv' : 'text/plain'; const response = await ctx.getDrive().files.export({ fileId, mimeType: exportMime }, { responseType: 'text' }); return json({ ...meta, text: String(response.data ?? '') }); }
        const response = await ctx.getDrive().files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }); const buffer = toBuffer(response.data); if (isTextMime(mime)) return json({ ...meta, text: buffer.toString('utf8') }); const office = await readableOfficeText(buffer, mime); if (office !== null) return json({ ...meta, text: office }); return blobResource(`gdrive:///${fileId}`, mime, buffer);
      }
      case 'fetch_file_revision': {
        const fileId = extractId(args.fileId); const metadata = await ctx.getDrive().files.get({ fileId, fields: 'id,name,mimeType', supportsAllDrives: true }); const mime = metadata.data.mimeType || 'application/octet-stream';
        if (mime.startsWith('application/vnd.google-apps.')) { const revision = await ctx.getDrive().revisions.get({ fileId, revisionId: args.revisionId, fields: 'id,modifiedTime,lastModifyingUser,exportLinks' }); const exportMime = args.exportMimeType || 'text/plain'; const url = revision.data.exportLinks?.[exportMime]; if (!url) return errorResponse(`Revision does not expose ${exportMime}.`); const response = await ctx.authClient.request({ url, responseType: 'arraybuffer' }); const data = toBuffer(response.data); return json({ ...revision.data, mimeType: exportMime, content: isTextMime(exportMime) ? data.toString('utf8') : data.toString('base64'), encoding: isTextMime(exportMime) ? 'utf8' : 'base64' }); }
        const response = await ctx.getDrive().revisions.get({ fileId, revisionId: args.revisionId, alt: 'media', acknowledgeAbuse: args.acknowledgeAbuse }, { responseType: 'arraybuffer' }); const data = toBuffer(response.data); return json({ fileId, revisionId: args.revisionId, mimeType: mime, content: isTextMime(mime) ? data.toString('utf8') : data.toString('base64'), encoding: isTextMime(mime) ? 'utf8' : 'base64' });
      }
      case 'find_document_text_range': { const documentId = pickId(args, 'document_id', 'document_url'); const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient }); const response = await docs.documents.get({ documentId, includeTabsContent: true }); const found = findDocText(response.data, args.text_to_find, Number(args.instance ?? 1), args.tab_id); return found ? json(found) : errorResponse('Text occurrence was not found.'); }
      case 'get_document': { const documentId = pickId(args, 'document_id', 'document_url'); const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient }); const response = await docs.documents.get({ documentId, includeTabsContent: true, ...(args.fields ? { fields: args.fields } : {}) }); return json(response.data); }
      case 'get_document_comments': { const fileId = pickId(args, 'document_id', 'document_url'); return driveComments(ctx, fileId, args); }
      case 'get_document_paragraph_range': { const documentId = pickId(args, 'document_id', 'document_url'); const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient }); const response = await docs.documents.get({ documentId, includeTabsContent: true }); for (const group of docGroups(response.data, args.tab_id)) for (const block of group.content) if (block?.paragraph && Number(block.startIndex ?? 0) <= Number(args.index_within) && Number(args.index_within) < Number(block.endIndex ?? 0)) return json({ startIndex: block.startIndex, endIndex: block.endIndex, ...(group.tabId ? { tabId: group.tabId } : {}) }); return errorResponse('No paragraph contains the requested index.'); }
      case 'get_document_tables': { const documentId = pickId(args, 'document_id', 'document_url'); const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient }); const response = await docs.documents.get({ documentId, includeTabsContent: true }); return json({ documentId, tables: extractDocTables(response.data, args.tab_id) }); }
      case 'get_document_text': { const documentId = pickId(args, 'document_id', 'document_url'); const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient }); const response = await docs.documents.get({ documentId, includeTabsContent: true }); return json({ documentId, paragraphs: docTextRecords(response.data, args.tab_id) }); }
      case 'get_file_comments': { const fileId = pickId(args, 'id', 'url'); return driveComments(ctx, fileId, args); }
      case 'get_file_metadata': { const fileId = extractId(args.fileId); const response = await ctx.getDrive().files.get({ fileId, supportsAllDrives: args.supportsAllDrives ?? true, ...(args.acknowledgeAbuse !== undefined ? { acknowledgeAbuse: args.acknowledgeAbuse } : {}), ...(args.supportsTeamDrives !== undefined ? { supportsTeamDrives: args.supportsTeamDrives } : {}), ...(args.includePermissionsForView ? { includePermissionsForView: args.includePermissionsForView } : {}), ...(args.includeLabels ? { includeLabels: args.includeLabels } : {}), fields: args.fields || 'id,name,mimeType,size,webViewLink,createdTime,modifiedTime,parents,shared,driveId,resourceKey,hasAugmentedPermissions,capabilities,permissions' }); return json(response.data); }
      case 'get_presentation': { const presentationId = pickId(args, 'presentation_id', 'presentation_url'); const slides = ctx.google.slides({ version: 'v1', auth: ctx.authClient }); const response = await slides.presentations.get({ presentationId, ...(args.fields ? { fields: args.fields } : {}) }); return json(response.data); }
      case 'get_presentation_comments': { const fileId = pickId(args, 'presentation_id', 'presentation_url'); return driveComments(ctx, fileId, args); }
      case 'get_presentation_outline': { const presentationId = pickId(args, 'presentation_id', 'presentation_url'); const slides = ctx.google.slides({ version: 'v1', auth: ctx.authClient }); const response = await slides.presentations.get({ presentationId, fields: 'presentationId,title,revisionId,slides(objectId,pageElements(objectId,shape,text,table))' }); return json(presentationOutline(response.data)); }
      case 'get_presentation_tables': { const presentationId = pickId(args, 'presentation_id', 'presentation_url'); const slides = ctx.google.slides({ version: 'v1', auth: ctx.authClient }); const response = await slides.presentations.get({ presentationId, fields: 'presentationId,slides(objectId,pageElements(objectId,table))' }); return json({ presentationId, tables: presentationTables(response.data) }); }
      case 'get_presentation_text': { const presentationId = pickId(args, 'presentation_id', 'presentation_url'); const slides = ctx.google.slides({ version: 'v1', auth: ctx.authClient }); const response = await slides.presentations.get({ presentationId, fields: 'presentationId,title,slides(objectId,pageElements(objectId,shape,text,table))' }); return json({ presentationId, title: response.data.title, slides: (response.data.slides ?? []).map((slide: any, index: number) => ({ slideNumber: index + 1, objectId: slide.objectId, text: slideTextFromElements(slide.pageElements) })) }); }
      case 'get_profile': { const response = await ctx.getDrive().about.get({ fields: 'user,storageQuota' }); return json(response.data); }
      case 'get_slide': { const presentationId = pickId(args, 'presentation_id', 'presentation_url'); const slides = ctx.google.slides({ version: 'v1', auth: ctx.authClient }); const response = await slides.presentations.pages.get({ presentationId, pageObjectId: args.slide_object_id }); return json(response.data); }
      case 'get_slide_thumbnail': { const presentationId = pickId(args, 'presentation_id', 'presentation_url'); const slides = ctx.google.slides({ version: 'v1', auth: ctx.authClient }); const size = args.thumbnail_size || 'MEDIUM'; const thumb = await slides.presentations.pages.getThumbnail({ presentationId, pageObjectId: args.slide_object_id, 'thumbnailProperties.mimeType': 'PNG', 'thumbnailProperties.thumbnailSize': size }); if (!thumb.data.contentUrl) return errorResponse('Google Slides returned no thumbnail URL.'); const image = await ctx.authClient.request({ url: thumb.data.contentUrl, responseType: 'arraybuffer' }); return imageAndMetadata(toBuffer(image.data), 'image/png', { presentationId, slideObjectId: args.slide_object_id, width: thumb.data.width, height: thumb.data.height, size }); }
      case 'get_spreadsheet_cells': { const spreadsheetId = pickId(args, 'spreadsheet_id', 'spreadsheet_url'); const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient }); const fields = args.cell_fields || 'userEnteredValue,userEnteredFormat'; const response = await sheets.spreadsheets.get({ spreadsheetId, ranges: args.ranges, includeGridData: true, fields: `spreadsheetId,sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(${fields}))))` }); return json(response.data); }
      case 'get_spreadsheet_comments': { const fileId = pickId(args, 'spreadsheet_id', 'spreadsheet_url'); return driveComments(ctx, fileId, args); }
      case 'get_spreadsheet_metadata': { const spreadsheetId = pickId(args, 'spreadsheet_id', 'spreadsheet_url'); const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient }); const fields = args.charts_only ? 'spreadsheetId,properties(title),sheets(properties(sheetId,title),charts)' : args.include_conditional_format_rules ? 'spreadsheetId,properties,sheets(properties,charts,conditionalFormats)' : 'spreadsheetId,properties,sheets(properties,charts)'; const response = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false, fields }); return json(response.data); }
      case 'get_spreadsheet_range': { const spreadsheetId = pickId(args, 'spreadsheet_id', 'spreadsheet_url'); const range = args.sheet_name && !String(args.range).includes('!') ? `${quoteSheetName(args.sheet_name)}!${args.range}` : args.range; const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient }); const response = await sheets.spreadsheets.values.get({ spreadsheetId, range, ...(args.value_render_option ? { valueRenderOption: args.value_render_option } : {}) }); return json(response.data); }
      case 'import_document': return importFile(ctx, args.source_file, args.title, args.upload_mode, DOC_MIME);
      case 'import_presentation': return importFile(ctx, args.source_file, args.title, args.upload_mode, SLIDES_MIME);
      case 'import_spreadsheet': return importFile(ctx, args.source_file, args.title, args.upload_mode, SHEET_MIME);
      case 'list_drives': { const response = await ctx.getDrive().drives.list({ pageSize: 100, fields: 'drives(id,name,createdTime,hidden,restrictions),nextPageToken' }); return json(response.data); }
      case 'list_file_revisions': { const fileId = extractId(args.fileId); const response = await ctx.getDrive().revisions.list({ fileId, pageSize: Math.min(Math.max(Number(args.pageSize ?? 100), 1), 1000), pageToken: args.pageToken, fields: 'nextPageToken,revisions(id,modifiedTime,keepForever,originalFilename,mimeType,size,lastModifyingUser,publishAutoPublished,published,publishedLink)' }); const revisions = response.data.revisions ?? []; return json({ nextPageToken: response.data.nextPageToken ?? null, revisions: revisions.map((revision: any, index: number) => ({ ...revision, previousRevisionId: index > 0 ? revisions[index - 1]?.id ?? null : null })) }); }
      case 'list_folder': { const fileId = args.url === 'root' ? 'root' : extractId(args.url); const response = await ctx.getDrive().files.list({ q: `'${fileId}' in parents and trashed = false`, pageSize: Math.min(Math.max(Number(args.top_k ?? 100), 1), 100), fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,parents,driveId)', supportsAllDrives: true, includeItemsFromAllDrives: true }); return json(response.data); }
      case 'recent_documents': { const response = await ctx.getDrive().files.list({ q: 'trashed = false', pageSize: Math.min(Math.max(Number(args.top_k), 1), 100), orderBy: 'modifiedTime desc', fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,viewedByMeTime,webViewLink,parents,driveId)', supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives' }); let files = response.data.files ?? []; if (args.require_viewed_by_user) files = files.filter((file: any) => Boolean(file.viewedByMeTime)); return json({ files, nextPageToken: response.data.nextPageToken ?? null }); }
      case 'search_spreadsheet_rows': {
        const spreadsheetId = pickId(args, 'spreadsheet_id', 'spreadsheet_url'); const startRow = Number(args.start_row ?? 1); let range = args.range;
        if (!range) { if (!args.end_row || !args.end_column) return errorResponse('range or end_row + end_column is required.'); range = `${args.sheet_name ? `${quoteSheetName(args.sheet_name)}!` : ''}${args.start_column || 'A'}${startRow}:${args.end_column}${args.end_row}`; }
        const local = String(range).includes('!') ? String(range).split('!').pop()! : String(range); const match = local.match(/^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/); if (match) { const cells = (Number(match[4]) - Number(match[2]) + 1) * (columnIndex(match[3]) - columnIndex(match[1]) + 1); if (cells > 50_000) return errorResponse('Search range may cover at most 50,000 cells.'); }
        const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient }); const response = await sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: 'FORMATTED_VALUE' }); const values = response.data.values ?? []; const scanStartColumn = match ? columnIndex(match[1]) : columnIndex(args.start_column || 'A'); const maxMatches = Number(args.max_matching_rows ?? args.max_rows ?? 100); const returnCols: string[] | null = Array.isArray(args.return_columns) ? args.return_columns : Array.isArray(args.column_numbers) ? args.column_numbers.map((value: number) => columnLetter(scanStartColumn + value - 1)) : null; const headerRow = args.header_row === null ? null : Number(args.header_row ?? 1); const absoluteStartRow = match ? Number(match[2]) : startRow; const headerIndex = headerRow === null ? -1 : headerRow - absoluteStartRow; const header = args.include_header_row !== false && headerIndex >= 0 && headerIndex < values.length ? values[headerIndex] : null; const needle = String(args.query).toLocaleLowerCase(); const matchesOut: any[] = [];
        for (let index = 0; index < values.length && matchesOut.length < maxMatches; index++) { const rowNumber = absoluteStartRow + index; if (headerRow !== null && rowNumber === headerRow) continue; const row = (values[index] ?? []).slice(0, Number(args.max_columns ?? 100)); if (!row.some((cell: any) => String(cell ?? '').toLocaleLowerCase().includes(needle))) continue; const selected = returnCols ? returnCols.map((col) => row[columnIndex(col) - scanStartColumn]) : row; matchesOut.push({ rowNumber, values: selected }); }
        return json({ spreadsheetId, range, header, matches: matchesOut });
      }
      case 'share_file': {
        const fileId = pickId(args, 'url'); if (!args.user_email && !args.anyone_at_company) return errorResponse('Provide user_email or set anyone_at_company=true.'); let requestBody: any;
        if (args.anyone_at_company) { const about = await ctx.getDrive().about.get({ fields: 'user(emailAddress)' }); const email = about.data.user?.emailAddress || ''; const domain = email.includes('@') ? email.split('@').pop()! : ''; if (!domain || /^(gmail|googlemail)\.com$/i.test(domain)) return errorResponse('anyone_at_company requires a Google Workspace domain account.'); requestBody = { type: 'domain', domain, role: args.permission, allowFileDiscovery: Boolean(args.show_in_search) }; }
        else requestBody = { type: 'user', emailAddress: args.user_email, role: args.permission };
        const response = await ctx.getDrive().permissions.create({ fileId, requestBody, fields: 'id,type,role,emailAddress,domain,allowFileDiscovery', supportsAllDrives: true, ...(args.permission === 'owner' ? { transferOwnership: true } : {}) }); return json(response.data);
      }
      case 'update_file': { const fileId = extractId(args.fileId); const requestBody: any = {}; if (args.name !== undefined && args.name !== null) requestBody.name = args.name; const params: any = { fileId, requestBody, supportsAllDrives: true, fields: 'id,name,mimeType,webViewLink,parents,modifiedTime' }; if (args.addParents) params.addParents = args.addParents; if (args.removeParents) params.removeParents = args.removeParents; if (args.file_uri !== undefined && args.file_uri !== null) { const file = localFile(args.file_uri, undefined, args.mime_type || undefined); if ([DOC_MIME, SHEET_MIME, SLIDES_MIME].includes(file.mimeType)) return errorResponse('Use native batch-update tools for Google Workspace file content.'); params.media = { mimeType: file.mimeType, body: createReadStream(file.path) }; } const response = await ctx.getDrive().files.update(params); return json(response.data); }
      case 'upload_file': { const file = localFile(args.file_uri, args.file_name || undefined, args.mime_type || undefined); const response = await ctx.getDrive().files.create({ requestBody: { name: args.file_name || file.name, ...(args.parent_folder_id ? { parents: [extractId(args.parent_folder_id)] } : {}) }, media: { mimeType: file.mimeType, body: createReadStream(file.path) }, fields: 'id,name,mimeType,webViewLink,parents,size', supportsAllDrives: true }); return json(response.data); }
      case 'download_file_lro': return startDownloadOperation(ctx, args);
      case 'get_download_operation': { const operation = (await ctx.authClient.request({ url: `https://www.googleapis.com/drive/v3/${String(args.operation_name).replace(/^\//, '')}`, method: 'GET' })).data; return maybeEmbedDownload(ctx, operation, Boolean(args.embed_result), Number(args.max_embed_bytes ?? 10_485_760)); }
      case 'generate_drive_ids': { const response = await ctx.getDrive().files.generateIds({ count: Math.min(Math.max(Number(args.count ?? 10), 1), 100), space: 'drive', type: 'files' }); return json(response.data); }
      case 'empty_trash': { if (args.confirm !== true) return errorResponse('confirm=true is required because emptying trash is permanent.'); await ctx.getDrive().files.emptyTrash({}); return json({ emptied: true, permanent: true }); }
      default: return null;
    }
  } catch (error: any) { return errorResponse(error?.message || String(error)); }
}
