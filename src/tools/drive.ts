import { z } from 'zod';
import * as base from './drive-base.js';
import { ALL_DRIVES_LIST_PARAMS, escapeDriveQuery } from '../utils.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOCUMENT_FILTER = [
  "mimeType = 'application/vnd.google-apps.document'",
  "mimeType = 'application/vnd.google-apps.spreadsheet'",
  "mimeType = 'application/vnd.google-apps.presentation'",
  "mimeType = 'application/pdf'",
  "mimeType contains 'text/'",
  "mimeType = 'application/msword'",
  "mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'",
  "mimeType = 'application/vnd.ms-excel'",
  "mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'",
  "mimeType = 'application/vnd.ms-powerpoint'",
  "mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'",
].join(' or ');

const OfficialSearchSchema = z.object({
  query: z.string().optional().default(''),
  topn: z.number().int().min(1).max(100).optional().default(20),
  special_filter_query_str: z.string().optional().default(''),
  best_effort_fetch: z.boolean().optional().default(false),
  fetch_ttl: z.number().positive().max(120).optional().default(15),
  require_viewed_by_user: z.boolean().optional().default(false),
  item_type: z.enum(['image', 'document', 'folder']).nullable().optional(),
  page_token: z.string().nullable().optional(),
});

const enhancedSearchDefinition: ToolDefinition = {
  name: 'search',
  description: 'Search Google Drive. Supports the upstream query/orderBy surface plus OpenAI-compatible topn, page_token, special_filter_query_str, item_type, require_viewed_by_user and best_effort_fetch fields.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', default: '' },
      pageSize: { type: 'number', minimum: 1, maximum: 100 },
      pageToken: { type: 'string' },
      rawQuery: { type: 'boolean' },
      orderBy: { type: 'string' },
      topn: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      special_filter_query_str: { type: 'string', default: '' },
      best_effort_fetch: { type: 'boolean', default: false },
      fetch_ttl: { type: 'number', minimum: 0.1, maximum: 120, default: 15 },
      require_viewed_by_user: { type: 'boolean', default: false },
      item_type: { type: ['string', 'null'], enum: ['image', 'document', 'folder', null] },
      page_token: { type: ['string', 'null'] },
    },
  },
};

export const toolDefinitions: ToolDefinition[] = base.toolDefinitions.map((definition) =>
  definition.name === 'search' ? enhancedSearchDefinition : definition,
);

function isOfficialSearchCall(args: Record<string, unknown>): boolean {
  const officialOnly = [
    'topn', 'special_filter_query_str', 'best_effort_fetch', 'fetch_ttl',
    'require_viewed_by_user', 'item_type', 'page_token',
  ];
  return !('query' in args) || officialOnly.some((key) => key in args);
}

async function withTimeout<T>(promise: Promise<T>, seconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('best-effort fetch timed out')), seconds * 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function hydrateText(ctx: ToolContext, file: any, ttl: number): Promise<string | null> {
  const drive = ctx.getDrive();
  const mimeType = String(file?.mimeType ?? '');
  const fileId = String(file?.id ?? '');
  if (!fileId) return null;

  try {
    let request: Promise<any>;
    if (mimeType === 'application/vnd.google-apps.document') {
      request = drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      request = drive.files.export({ fileId, mimeType: 'text/csv' }, { responseType: 'text' });
    } else if (mimeType === 'application/vnd.google-apps.presentation') {
      request = drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
    } else if (mimeType.startsWith('text/') || mimeType === 'application/json') {
      request = drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
    } else {
      return null;
    }
    const response = await withTimeout(request, ttl);
    const text = typeof response?.data === 'string' ? response.data : String(response?.data ?? '');
    return text.slice(0, 20_000);
  } catch {
    return null;
  }
}

async function handleOfficialSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const parsed = OfficialSearchSchema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Error: ${parsed.error.errors[0].message}` }], isError: true };
  }
  const a = parsed.data;
  const clauses: string[] = ['trashed = false'];
  if (a.query.trim()) clauses.unshift(`fullText contains '${escapeDriveQuery(a.query.trim())}'`);
  if (a.special_filter_query_str.trim()) clauses.unshift(`(${a.special_filter_query_str.trim()})`);
  if (a.item_type === 'image') clauses.unshift("mimeType contains 'image/'");
  if (a.item_type === 'folder') clauses.unshift(`mimeType = '${FOLDER_MIME}'`);
  if (a.item_type === 'document') clauses.unshift(`(${DOCUMENT_FILTER})`);

  const response = await ctx.getDrive().files.list({
    q: clauses.join(' and '),
    pageSize: a.topn,
    pageToken: a.page_token ?? undefined,
    orderBy: 'modifiedTime desc',
    fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,createdTime,modifiedTime,viewedByMeTime,size,parents,driveId,webViewLink,iconLink,thumbnailLink,capabilities(canDownload,canEdit,canShare))',
    ...ALL_DRIVES_LIST_PARAMS,
  });

  let files = response.data.files ?? [];
  if (a.require_viewed_by_user) files = files.filter((file) => Boolean(file.viewedByMeTime));

  const explicitMetadataOnly = Boolean(a.item_type);
  const results = await Promise.all(files.map(async (file) => ({
    ...file,
    ...(a.best_effort_fetch && !explicitMetadataOnly
      ? { best_effort_text: await hydrateText(ctx, file, a.fetch_ttl) }
      : {}),
  })));

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        files: results,
        next_page_token: response.data.nextPageToken ?? null,
        incomplete_search: Boolean(response.data.incompleteSearch),
        metadata_only: explicitMetadataOnly,
      }, null, 2),
    }],
    isError: false,
  };
}

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (toolName === 'search' && isOfficialSearchCall(args)) return handleOfficialSearch(args, ctx);
  return base.handleTool(toolName, args, ctx);
}
