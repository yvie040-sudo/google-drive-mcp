import { randomUUID } from 'node:crypto';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { errorResponse } from '../types.js';

function def(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) } };
}

function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }], isError: false };
}

function extractId(value: string): string {
  const raw = value.trim();
  if (!/^https?:\/\//i.test(raw)) return raw;
  for (const pattern of [/\/d\/([A-Za-z0-9_-]+)/, /\/folders\/([A-Za-z0-9_-]+)/, /[?&]id=([A-Za-z0-9_-]+)/]) {
    const match = raw.match(pattern);
    if (match) return match[1];
  }
  throw new Error(`Could not extract a Google Drive ID from ${raw}`);
}

function pickFileId(args: Record<string, any>): string {
  const value = args.file_id ?? args.fileId ?? args.url;
  if (typeof value !== 'string' || !value.trim()) throw new Error('file_id, fileId, or url is required.');
  return extractId(value);
}

function encode(value: unknown): string { return encodeURIComponent(String(value ?? '')); }
function joinMaybe(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join(',') || undefined;
  return typeof value === 'string' && value ? value : undefined;
}

const DRIVE_ROOT = 'https://www.googleapis.com/drive/v3';

async function request(ctx: ToolContext, method: string, url: string, params?: Record<string, unknown>, data?: unknown): Promise<any> {
  return (await ctx.authClient.request({ method, url, ...(params ? { params } : {}), ...(data !== undefined ? { data } : {}) })).data;
}

const fileRef = { file_id: { type: 'string' }, fileId: { type: 'string' }, url: { type: 'string' } };

export const toolDefinitions: ToolDefinition[] = [
  def('list_access_proposals', 'List pending access proposals on a Drive file, or get one proposal by ID.', { ...fileRef, proposal_id: { type: 'string' }, page_size: { type: 'integer', minimum: 1, maximum: 100, default: 100 }, page_token: { type: 'string' } }),
  def('resolve_access_proposal', 'Accept or deny a pending Drive access proposal.', { ...fileRef, proposal_id: { type: 'string' }, action: { type: 'string', enum: ['ACCEPT','DENY'] }, roles: { type: 'array', items: { type: 'string' } }, view: { type: 'string', enum: ['published'] }, send_notification: { type: 'boolean', default: true } }, ['proposal_id','action']),
  def('get_drive_app', 'Get metadata for one Drive-connected application.', { app_id: { type: 'string' } }, ['app_id']),
  def('list_drive_apps', 'List applications installed by or authorized for the Drive user. Requires drive.apps.readonly.', { app_filter_extensions: { type: 'array', items: { type: 'string' } }, app_filter_mime_types: { type: 'array', items: { type: 'string' } }, language_code: { type: 'string' } }),
  def('get_drive_comment', 'Get one Drive comment by ID, including its reply thread.', { ...fileRef, comment_id: { type: 'string' }, include_deleted: { type: 'boolean', default: false } }, ['comment_id']),
  def('modify_drive_comment', 'Update or delete one Drive comment.', { ...fileRef, comment_id: { type: 'string' }, action: { type: 'string', enum: ['update','delete'] }, content: { type: 'string' } }, ['comment_id','action']),
  def('list_drive_replies', 'List replies to a Drive comment, or get one reply by ID.', { ...fileRef, comment_id: { type: 'string' }, reply_id: { type: 'string' }, include_deleted: { type: 'boolean', default: false }, page_size: { type: 'integer', minimum: 1, maximum: 100, default: 100 }, page_token: { type: 'string' } }, ['comment_id']),
  def('modify_drive_reply', 'Create, update, or delete a Drive comment reply. Create also supports resolve/reopen actions.', { ...fileRef, comment_id: { type: 'string' }, reply_id: { type: 'string' }, operation: { type: 'string', enum: ['create','update','delete'] }, content: { type: 'string' }, action: { type: 'string', enum: ['resolve','reopen'] } }, ['comment_id','operation']),
  def('get_file_permission', 'Get one Drive permission by ID.', { ...fileRef, permission_id: { type: 'string' }, use_domain_admin_access: { type: 'boolean', default: false }, fields: { type: 'string', default: '*' } }, ['permission_id']),
  def('manage_file_revision', 'Update revision metadata (for example keepForever/published) or permanently delete a binary-file revision.', { ...fileRef, revision_id: { type: 'string' }, action: { type: 'string', enum: ['update','delete'] }, keep_forever: { type: 'boolean' }, published: { type: 'boolean' }, publish_auto: { type: 'boolean' }, published_outside_domain: { type: 'boolean' } }, ['revision_id','action']),
  def('watch_drive_resource', 'Register a Google Drive push-notification webhook for one file or the changes feed. This creates an external notification channel.', { resource_type: { type: 'string', enum: ['file','changes'] }, ...fileRef, page_token: { type: 'string' }, drive_id: { type: 'string' }, address: { type: 'string' }, channel_id: { type: 'string' }, token: { type: 'string' }, expiration: { type: 'integer' }, include_removed: { type: 'boolean', default: true }, spaces: { type: 'string' }, include_permissions_for_view: { type: 'string' }, include_labels: { type: 'string' } }, ['resource_type','address']),
  def('stop_drive_channel', 'Stop an existing Google Drive push-notification channel.', { channel_id: { type: 'string' }, resource_id: { type: 'string' } }, ['channel_id','resource_id']),
  def('generate_drive_cse_token', 'Generate a Drive client-side-encryption (CSE) JWT for an existing file or a new file under a parent. Requires full drive (or docs) scope.', { file_id: { type: 'string' }, parent_id: { type: 'string' } }),
];

function validateHttpsAddress(address: unknown): string | ToolResult {
  if (typeof address !== 'string' || !address.trim()) return errorResponse('address is required.');
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:') return errorResponse('Drive webhook address must use HTTPS.');
    return url.toString();
  } catch {
    return errorResponse('address must be a valid HTTPS URL.');
  }
}

export async function handleTool(toolName: string, args: Record<string, any>, ctx: ToolContext): Promise<ToolResult | null> {
  try {
    switch (toolName) {
      case 'list_access_proposals': {
        const fileId = pickFileId(args);
        if (args.proposal_id) return json(await request(ctx, 'GET', `${DRIVE_ROOT}/files/${encode(fileId)}/accessproposals/${encode(args.proposal_id)}`));
        return json(await request(ctx, 'GET', `${DRIVE_ROOT}/files/${encode(fileId)}/accessproposals`, { pageSize: args.page_size ?? 100, pageToken: args.page_token }));
      }
      case 'resolve_access_proposal': {
        const fileId = pickFileId(args);
        const action = String(args.action || '');
        if (!['ACCEPT','DENY'].includes(action)) return errorResponse('action must be ACCEPT or DENY.');
        if (action === 'ACCEPT' && (!Array.isArray(args.roles) || args.roles.length < 1)) return errorResponse('roles must contain at least one role when action=ACCEPT.');
        return json(await request(ctx, 'POST', `${DRIVE_ROOT}/files/${encode(fileId)}/accessproposals/${encode(args.proposal_id)}:resolve`, undefined, {
          action,
          ...(Array.isArray(args.roles) ? { role: args.roles } : {}),
          ...(args.view ? { view: args.view } : {}),
          sendNotification: args.send_notification !== false,
        }));
      }
      case 'get_drive_app': {
        return json(await request(ctx, 'GET', `${DRIVE_ROOT}/apps/${encode(args.app_id)}`));
      }
      case 'list_drive_apps': {
        return json(await request(ctx, 'GET', `${DRIVE_ROOT}/apps`, {
          appFilterExtensions: joinMaybe(args.app_filter_extensions),
          appFilterMimeTypes: joinMaybe(args.app_filter_mime_types),
          languageCode: args.language_code,
        }));
      }
      case 'get_drive_comment': {
        const fileId = pickFileId(args);
        return json(await request(ctx, 'GET', `${DRIVE_ROOT}/files/${encode(fileId)}/comments/${encode(args.comment_id)}`, { includeDeleted: Boolean(args.include_deleted), fields: '*' }));
      }
      case 'modify_drive_comment': {
        const fileId = pickFileId(args);
        const url = `${DRIVE_ROOT}/files/${encode(fileId)}/comments/${encode(args.comment_id)}`;
        if (args.action === 'delete') return json(await request(ctx, 'DELETE', url));
        if (args.action !== 'update') return errorResponse('action must be update or delete.');
        if (typeof args.content !== 'string') return errorResponse('content is required for action=update.');
        return json(await request(ctx, 'PATCH', url, { fields: '*' }, { content: args.content }));
      }
      case 'list_drive_replies': {
        const fileId = pickFileId(args);
        const base = `${DRIVE_ROOT}/files/${encode(fileId)}/comments/${encode(args.comment_id)}/replies`;
        if (args.reply_id) return json(await request(ctx, 'GET', `${base}/${encode(args.reply_id)}`, { includeDeleted: Boolean(args.include_deleted), fields: '*' }));
        return json(await request(ctx, 'GET', base, { includeDeleted: Boolean(args.include_deleted), pageSize: args.page_size ?? 100, pageToken: args.page_token, fields: '*' }));
      }
      case 'modify_drive_reply': {
        const fileId = pickFileId(args);
        const base = `${DRIVE_ROOT}/files/${encode(fileId)}/comments/${encode(args.comment_id)}/replies`;
        const operation = String(args.operation || '');
        if (operation === 'create') {
          if (args.content === undefined && args.action === undefined) return errorResponse('content or action is required for operation=create.');
          return json(await request(ctx, 'POST', base, { fields: '*' }, { ...(args.content !== undefined ? { content: args.content } : {}), ...(args.action ? { action: args.action } : {}) }));
        }
        if (!args.reply_id) return errorResponse('reply_id is required for update/delete.');
        const url = `${base}/${encode(args.reply_id)}`;
        if (operation === 'delete') return json(await request(ctx, 'DELETE', url));
        if (operation !== 'update') return errorResponse('operation must be create, update, or delete.');
        if (typeof args.content !== 'string') return errorResponse('content is required for operation=update.');
        return json(await request(ctx, 'PATCH', url, { fields: '*' }, { content: args.content }));
      }
      case 'get_file_permission': {
        const fileId = pickFileId(args);
        return json(await request(ctx, 'GET', `${DRIVE_ROOT}/files/${encode(fileId)}/permissions/${encode(args.permission_id)}`, { supportsAllDrives: true, useDomainAdminAccess: Boolean(args.use_domain_admin_access), fields: args.fields || '*' }));
      }
      case 'manage_file_revision': {
        const fileId = pickFileId(args);
        const url = `${DRIVE_ROOT}/files/${encode(fileId)}/revisions/${encode(args.revision_id)}`;
        if (args.action === 'delete') return json(await request(ctx, 'DELETE', url));
        if (args.action !== 'update') return errorResponse('action must be update or delete.');
        const body: Record<string, unknown> = {};
        if (args.keep_forever !== undefined) body.keepForever = Boolean(args.keep_forever);
        if (args.published !== undefined) body.published = Boolean(args.published);
        if (args.publish_auto !== undefined) body.publishAuto = Boolean(args.publish_auto);
        if (args.published_outside_domain !== undefined) body.publishedOutsideDomain = Boolean(args.published_outside_domain);
        if (Object.keys(body).length === 0) return errorResponse('At least one revision field is required for action=update.');
        return json(await request(ctx, 'PATCH', url, { fields: '*' }, body));
      }
      case 'watch_drive_resource': {
        const address = validateHttpsAddress(args.address);
        if (typeof address !== 'string') return address;
        const resourceType = String(args.resource_type || '');
        const channel = {
          id: args.channel_id || randomUUID(),
          type: 'web_hook',
          address,
          ...(args.token ? { token: args.token } : {}),
          ...(args.expiration ? { expiration: String(args.expiration) } : {}),
        };
        if (resourceType === 'file') {
          const fileId = pickFileId(args);
          return json(await request(ctx, 'POST', `${DRIVE_ROOT}/files/${encode(fileId)}/watch`, { supportsAllDrives: true, includePermissionsForView: args.include_permissions_for_view, includeLabels: args.include_labels }, channel));
        }
        if (resourceType === 'changes') {
          if (!args.page_token) return errorResponse('page_token is required when resource_type=changes. Get one with get_drive_start_page_token.');
          return json(await request(ctx, 'POST', `${DRIVE_ROOT}/changes/watch`, { pageToken: args.page_token, driveId: args.drive_id, includeRemoved: args.include_removed !== false, includeItemsFromAllDrives: true, supportsAllDrives: true, spaces: args.spaces, includePermissionsForView: args.include_permissions_for_view, includeLabels: args.include_labels }, channel));
        }
        return errorResponse('resource_type must be file or changes.');
      }
      case 'stop_drive_channel': {
        return json(await request(ctx, 'POST', `${DRIVE_ROOT}/channels/stop`, undefined, { id: args.channel_id, resourceId: args.resource_id }));
      }
      case 'generate_drive_cse_token': {
        if (args.file_id && args.parent_id) return errorResponse('Provide file_id or parent_id, not both.');
        return json(await request(ctx, 'GET', `${DRIVE_ROOT}/files/generateCseToken`, { fileId: args.file_id, parent: args.parent_id }));
      }
      default: return null;
    }
  } catch (error: any) {
    return errorResponse(error?.message || String(error));
  }
}
