import * as base from './calendar-base.js';
import * as parity from './openai-drive-parity.js';
import * as extended from './google-drive-extended.js';
import * as complete from './google-drive-complete.js';
import * as googleRemote from './google-drive-remote-compat.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

export const toolDefinitions: ToolDefinition[] = [
  ...base.toolDefinitions,
  ...parity.toolDefinitions,
  ...extended.toolDefinitions,
  ...complete.toolDefinitions,
  ...googleRemote.toolDefinitions,
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
  const extendedResult = await extended.handleTool(toolName, args, ctx);
  if (extendedResult !== null) return extendedResult;
  const completeResult = await complete.handleTool(toolName, args, ctx);
  if (completeResult !== null) return completeResult;
  return googleRemote.handleTool(toolName, args, ctx);
}
