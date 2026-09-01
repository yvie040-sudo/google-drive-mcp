import * as base from './google-drive-extended-base.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { errorResponse } from '../types.js';

export const toolDefinitions: ToolDefinition[] = base.toolDefinitions;

const APPROVAL_ACTIONS = new Set(['start','approve','decline','reassign','cancel','comment']);
const LABEL_CATALOG_ACTIONS = new Set(['list','get']);
const LABEL_SCHEMA_ACTIONS = new Set(['create','delta','publish','disable','enable','delete']);
const SHARED_DRIVE_ACTIONS = new Set(['create','update','delete','hide','unhide']);

function validate(toolName: string, args: Record<string, any>): ToolResult | null {
  if (toolName === 'manage_drive_approval') {
    const action = String(args.action || '');
    if (!APPROVAL_ACTIONS.has(action)) return errorResponse('Unsupported approval action.');
    if (action === 'start' && (!Array.isArray(args.reviewer_emails) || args.reviewer_emails.length < 1)) {
      return errorResponse('reviewer_emails must contain at least one reviewer when starting an approval.');
    }
    if (action !== 'start' && !args.approval_id) return errorResponse('approval_id is required for this approval action.');
    if (action === 'comment' && !args.message) return errorResponse('message is required for action=comment.');
    if (action === 'reassign' && !((Array.isArray(args.add_reviewers) && args.add_reviewers.length) || (Array.isArray(args.replace_reviewers) && args.replace_reviewers.length))) {
      return errorResponse('add_reviewers or replace_reviewers is required for action=reassign.');
    }
  }
  if (toolName === 'drive_labels_catalog') {
    const action = String(args.action || '');
    if (!LABEL_CATALOG_ACTIONS.has(action)) return errorResponse('action must be list or get.');
    if (action === 'get' && !args.name) return errorResponse('name is required for action=get.');
  }
  if (toolName === 'manage_drive_label_schema') {
    const action = String(args.action || '');
    if (!LABEL_SCHEMA_ACTIONS.has(action)) return errorResponse('Unsupported Drive Labels action.');
    if (action !== 'create' && !args.name) return errorResponse('name is required for this Drive Labels action.');
    if ((action === 'create' || action === 'delta') && (!args.request_body || typeof args.request_body !== 'object')) {
      return errorResponse('request_body is required for create and delta label actions.');
    }
  }
  if (toolName === 'manage_shared_drive') {
    const action = String(args.action || '');
    if (!SHARED_DRIVE_ACTIONS.has(action)) return errorResponse('Unsupported shared-drive action.');
    if (action === 'create' && !args.name && !args.request_body?.name) return errorResponse('name is required for action=create.');
    if (action !== 'create' && !args.drive_id) return errorResponse('drive_id is required for this shared-drive action.');
    if (action === 'delete' && args.allow_item_deletion && !args.use_domain_admin_access) {
      return errorResponse('allow_item_deletion=true requires use_domain_admin_access=true.');
    }
  }
  if (toolName === 'query_drive_activity' && !args.item_id && !args.ancestor_id) {
    return errorResponse('item_id or ancestor_id is required.');
  }
  return null;
}

export async function handleTool(toolName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  const validationError = validate(toolName, args as Record<string, any>);
  if (validationError) return validationError;
  return base.handleTool(toolName, args, ctx);
}
