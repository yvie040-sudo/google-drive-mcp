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
  throw new Error(`Could not extract a Drive ID from ${raw}`);
}

function pickId(args: Record<string, any>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return extractId(value);
  }
  throw new Error(`One of ${keys.join(', ')} is required.`);
}

const fileRef = { file_id: { type: 'string' }, url: { type: 'string' } };

export const toolDefinitions: ToolDefinition[] = [
  def('list_file_labels', 'List labels currently applied to one Drive file.', { ...fileRef, max_results: { type: 'integer', minimum: 1, maximum: 100, default: 100 }, page_token: { type: 'string' } }),
  def('modify_file_labels', 'Atomically apply, change, unset, or remove labels on one Drive file using raw Drive labelModifications.', { ...fileRef, label_modifications: { type: 'array', minItems: 1, items: { type: 'object' } } }, ['label_modifications']),
  def('list_drive_approvals', 'List or get Drive content approvals. Approvals are GA and use normal Drive scopes.', { ...fileRef, approval_id: { type: 'string' }, page_size: { type: 'integer', minimum: 1, maximum: 100, default: 100 }, page_token: { type: 'string' } }),
  def('manage_drive_approval', 'Start, approve, decline, reassign, cancel, or comment on a Drive approval.', { ...fileRef, action: { type: 'string', enum: ['start','approve','decline','reassign','cancel','comment'] }, approval_id: { type: 'string' }, reviewer_emails: { type: 'array', items: { type: 'string' } }, due_time: { type: 'string' }, lock_file: { type: 'boolean' }, message: { type: 'string' }, file_content_change_behavior: { type: 'string' }, add_reviewers: { type: 'array', items: { type: 'object' } }, replace_reviewers: { type: 'array', items: { type: 'object' } } }, ['action']),
  def('query_drive_activity', 'Query the Drive Activity API v2 for an item or folder ancestry. Requires drive.activity.readonly or drive.activity.', { item_id: { type: 'string' }, ancestor_id: { type: 'string' }, filter: { type: 'string' }, page_size: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, page_token: { type: 'string' }, consolidation_strategy: { type: 'object' } }),
  def('drive_labels_catalog', 'List or get Drive Label schema definitions. Requires a Drive Labels read scope.', { action: { type: 'string', enum: ['list','get'] }, name: { type: 'string' }, customer: { type: 'string' }, view: { type: 'string', default: 'LABEL_VIEW_FULL' }, published_only: { type: 'boolean' }, page_size: { type: 'integer', minimum: 1, maximum: 100 }, page_token: { type: 'string' }, use_admin_access: { type: 'boolean', default: false } }, ['action']),
  def('manage_drive_label_schema', 'Create, delta-update, publish, disable, enable, or delete a Drive Label schema. Requires Drive Labels write/admin scopes.', { action: { type: 'string', enum: ['create','delta','publish','disable','enable','delete'] }, name: { type: 'string' }, use_admin_access: { type: 'boolean', default: false }, request_body: { type: 'object' } }, ['action']),
  def('get_shared_drive', 'Get Shared Drive metadata, optionally using domain-admin access.', { drive_id: { type: 'string' }, use_domain_admin_access: { type: 'boolean', default: false } }, ['drive_id']),
  def('manage_shared_drive', 'Create, update, delete, hide, or unhide a Shared Drive.', { action: { type: 'string', enum: ['create','update','delete','hide','unhide'] }, drive_id: { type: 'string' }, name: { type: 'string' }, request_id: { type: 'string' }, request_body: { type: 'object' }, use_domain_admin_access: { type: 'boolean', default: false }, allow_item_deletion: { type: 'boolean', default: false } }, ['action']),
  def('get_drive_start_page_token', 'Get a Drive changes start page token for incremental synchronization.', { drive_id: { type: 'string' } }),
  def('list_drive_changes', 'List Drive changes from a page token, including shared-drive changes.', { page_token: { type: 'string' }, drive_id: { type: 'string' }, page_size: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }, include_removed: { type: 'boolean', default: true } }, ['page_token']),
  def('list_trash', 'List trashed Drive items without deleting them.', { top_k: { type: 'integer', minimum: 1, maximum: 100, default: 100 }, page_token: { type: 'string' } }),
  def('restore_from_trash', 'Restore one trashed Drive item by setting trashed=false.', { ...fileRef }),
];

const DRIVE_ROOT = 'https://www.googleapis.com/drive/v3';
const LABELS_ROOT = 'https://drivelabels.googleapis.com/v2';

async function request(ctx: ToolContext, method: string, url: string, params?: Record<string, unknown>, data?: unknown): Promise<any> {
  return (await ctx.authClient.request({ method, url, ...(params ? { params } : {}), ...(data !== undefined ? { data } : {}) })).data;
}

export async function handleTool(toolName: string, args: Record<string, any>, ctx: ToolContext): Promise<ToolResult | null> {
  try {
    switch (toolName) {
      case 'list_file_labels': {
        const fileId = pickId(args, 'file_id', 'url');
        return json(await request(ctx, 'GET', `${DRIVE_ROOT}/files/${encodeURIComponent(fileId)}/listLabels`, { maxResults: args.max_results ?? 100, pageToken: args.page_token }));
      }
      case 'modify_file_labels': {
        const fileId = pickId(args, 'file_id', 'url');
        if (!Array.isArray(args.label_modifications) || args.label_modifications.length < 1) return errorResponse('label_modifications must contain at least one modification.');
        return json(await request(ctx, 'POST', `${DRIVE_ROOT}/files/${encodeURIComponent(fileId)}/modifyLabels`, undefined, { labelModifications: args.label_modifications }));
      }
      case 'list_drive_approvals': {
        const fileId = pickId(args, 'file_id', 'url');
        const fields = '*';
        if (args.approval_id) return json(await request(ctx, 'GET', `${DRIVE_ROOT}/files/${encodeURIComponent(fileId)}/approvals/${encodeURIComponent(args.approval_id)}`, { fields }));
        return json(await request(ctx, 'GET', `${DRIVE_ROOT}/files/${encodeURIComponent(fileId)}/approvals`, { pageSize: args.page_size ?? 100, pageToken: args.page_token, fields }));
      }
      case 'manage_drive_approval': {
        const fileId = pickId(args, 'file_id', 'url');
        const action = String(args.action || '');
        if (action === 'start') {
          const capabilities = await ctx.getDrive().files.get({ fileId, fields: 'capabilities(canStartApproval)', supportsAllDrives: true });
          const canStartApproval = (capabilities.data.capabilities as unknown as { canStartApproval?: boolean } | undefined)?.canStartApproval;
          if (canStartApproval === false) return errorResponse('Google Drive reports capabilities.canStartApproval=false for this file.');
          const body = {
            reviewerEmails: args.reviewer_emails ?? [],
            ...(args.due_time ? { dueTime: args.due_time } : {}),
            ...(args.lock_file !== undefined ? { lockFile: args.lock_file } : {}),
            ...(args.message ? { message: args.message } : {}),
            ...(args.file_content_change_behavior ? { fileContentChangeBehavior: args.file_content_change_behavior } : {}),
          };
          return json(await request(ctx, 'POST', `${DRIVE_ROOT}/files/${encodeURIComponent(fileId)}/approvals:start`, { fields: '*' }, body));
        }
        if (!args.approval_id) return errorResponse('approval_id is required for this approval action.');
        const approvalId = encodeURIComponent(args.approval_id);
        let body: Record<string, unknown> = {};
        if (action === 'reassign') body = { ...(args.add_reviewers ? { addReviewers: args.add_reviewers } : {}), ...(args.replace_reviewers ? { replaceReviewers: args.replace_reviewers } : {}), ...(args.message ? { message: args.message } : {}) };
        else if (args.message) body = { message: args.message };
        return json(await request(ctx, 'POST', `${DRIVE_ROOT}/files/${encodeURIComponent(fileId)}/approvals/${approvalId}:${action}`, { fields: '*' }, body));
      }
      case 'query_drive_activity': {
        if (!args.item_id && !args.ancestor_id) return errorResponse('item_id or ancestor_id is required.');
        const body = {
          ...(args.item_id ? { itemName: `items/${extractId(args.item_id)}` } : {}),
          ...(args.ancestor_id ? { ancestorName: `items/${extractId(args.ancestor_id)}` } : {}),
          ...(args.filter ? { filter: args.filter } : {}),
          pageSize: args.page_size ?? 50,
          ...(args.page_token ? { pageToken: args.page_token } : {}),
          ...(args.consolidation_strategy ? { consolidationStrategy: args.consolidation_strategy } : {}),
        };
        return json(await request(ctx, 'POST', 'https://driveactivity.googleapis.com/v2/activity:query', undefined, body));
      }
      case 'drive_labels_catalog': {
        const view = args.view || 'LABEL_VIEW_FULL';
        if (args.action === 'get') {
          if (!args.name) return errorResponse('name is required for action=get.');
          const name = String(args.name).startsWith('labels/') ? String(args.name) : `labels/${args.name}`;
          return json(await request(ctx, 'GET', `${LABELS_ROOT}/${name}`, { view, useAdminAccess: Boolean(args.use_admin_access) }));
        }
        return json(await request(ctx, 'GET', `${LABELS_ROOT}/labels`, { customer: args.customer, view, publishedOnly: args.published_only, pageSize: args.page_size, pageToken: args.page_token, useAdminAccess: Boolean(args.use_admin_access) }));
      }
      case 'manage_drive_label_schema': {
        const action = String(args.action || '');
        if (action === 'create') return json(await request(ctx, 'POST', `${LABELS_ROOT}/labels`, { useAdminAccess: Boolean(args.use_admin_access) }, args.request_body ?? {}));
        if (!args.name) return errorResponse('name is required for this label action.');
        const name = String(args.name).startsWith('labels/') ? String(args.name) : `labels/${args.name}`;
        if (action === 'delete') return json(await request(ctx, 'DELETE', `${LABELS_ROOT}/${name}`, { useAdminAccess: Boolean(args.use_admin_access) }));
        const body = { ...(args.request_body ?? {}), useAdminAccess: Boolean(args.use_admin_access) };
        return json(await request(ctx, 'POST', `${LABELS_ROOT}/${name}:${action}`, undefined, body));
      }
      case 'get_shared_drive': {
        return json(await request(ctx, 'GET', `${DRIVE_ROOT}/drives/${encodeURIComponent(args.drive_id)}`, { useDomainAdminAccess: Boolean(args.use_domain_admin_access) }));
      }
      case 'manage_shared_drive': {
        const action = String(args.action || '');
        if (action === 'create') {
          if (!args.name && !args.request_body?.name) return errorResponse('name is required for action=create.');
          return json(await request(ctx, 'POST', `${DRIVE_ROOT}/drives`, { requestId: args.request_id || randomUUID() }, args.request_body ?? { name: args.name }));
        }
        if (!args.drive_id) return errorResponse('drive_id is required for this shared-drive action.');
        const url = `${DRIVE_ROOT}/drives/${encodeURIComponent(args.drive_id)}`;
        if (action === 'update') return json(await request(ctx, 'PATCH', url, { useDomainAdminAccess: Boolean(args.use_domain_admin_access) }, args.request_body ?? (args.name ? { name: args.name } : {})));
        if (action === 'delete') return json(await request(ctx, 'DELETE', url, { useDomainAdminAccess: Boolean(args.use_domain_admin_access), allowItemDeletion: Boolean(args.allow_item_deletion) }));
        return json(await request(ctx, 'POST', `${url}/${action}`, { useDomainAdminAccess: Boolean(args.use_domain_admin_access) }, {}));
      }
      case 'get_drive_start_page_token': {
        return json(await request(ctx, 'GET', `${DRIVE_ROOT}/changes/startPageToken`, { driveId: args.drive_id, supportsAllDrives: true }));
      }
      case 'list_drive_changes': {
        return json(await request(ctx, 'GET', `${DRIVE_ROOT}/changes`, { pageToken: args.page_token, driveId: args.drive_id, pageSize: args.page_size ?? 100, includeRemoved: args.include_removed !== false, includeItemsFromAllDrives: true, supportsAllDrives: true, fields: 'nextPageToken,newStartPageToken,changes(type,time,removed,fileId,driveId,file(id,name,mimeType,modifiedTime,trashed,parents,driveId))' }));
      }
      case 'list_trash': {
        const response = await ctx.getDrive().files.list({ q: 'trashed = true', pageSize: Math.min(Math.max(Number(args.top_k ?? 100), 1), 100), pageToken: args.page_token, orderBy: 'modifiedTime desc', fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,parents,driveId,webViewLink)', corpora: 'allDrives', includeItemsFromAllDrives: true, supportsAllDrives: true });
        return json(response.data);
      }
      case 'restore_from_trash': {
        const fileId = pickId(args, 'file_id', 'url');
        const response = await ctx.getDrive().files.update({ fileId, requestBody: { trashed: false }, fields: 'id,name,mimeType,trashed,parents,driveId,webViewLink', supportsAllDrives: true });
        return json(response.data);
      }
      default: return null;
    }
  } catch (error: any) {
    return errorResponse(error?.message || String(error));
  }
}
