import * as base from './calendar-base.js';
import * as parity from './openai-drive-parity.js';
import * as extended from './google-drive-extended.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

export const toolDefinitions: ToolDefinition[] = [
  ...base.toolDefinitions,
  ...parity.toolDefinitions,
  ...extended.toolDefinitions,
];

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  const baseResult = await base.handleTool(toolName, args, ctx);
  if (baseResult !== null) return baseResult;
  const parityResult = await parity.handleTool(toolName, args, ctx);
  if (parityResult !== null) return parityResult;
  return extended.handleTool(toolName, args, ctx);
}
