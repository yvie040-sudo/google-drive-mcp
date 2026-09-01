import * as base from './calendar-base.js';
import * as parity from './openai-drive-parity.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

export const toolDefinitions: ToolDefinition[] = [...base.toolDefinitions, ...parity.toolDefinitions];

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  const baseResult = await base.handleTool(toolName, args, ctx);
  if (baseResult !== null) return baseResult;
  return parity.handleTool(toolName, args, ctx);
}
