import * as dual from './openai-drive-parity-google.js';
import { tryGoogleFirstPartyDriveTool } from './google-drive-first-party-client.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

export const toolDefinitions: ToolDefinition[] = dual.toolDefinitions;

function isGoogleCopy(args: Record<string, unknown>): boolean {
  return typeof args.fileId === 'string' && args.fileId.length > 0;
}

function isGoogleCreate(args: Record<string, unknown>): boolean {
  return ['mimeType','contentMimeType','content','base64Content','textContent','parentId','disableConversionToGoogleType']
    .some((key) => key in args) && !('mime_type' in args);
}

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  const googleDialect =
    (toolName === 'copy_file' && isGoogleCopy(args)) ||
    (toolName === 'create_file' && isGoogleCreate(args));

  if (googleDialect) {
    const providerResult = await tryGoogleFirstPartyDriveTool(ctx, toolName, args);
    if (providerResult !== null) return providerResult;
  }
  return dual.handleTool(toolName, args, ctx);
}
