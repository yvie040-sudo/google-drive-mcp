import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolContext, ToolResult } from '../types.js';

const DEFAULT_GOOGLE_DRIVE_MCP_URL = 'https://drivemcp.googleapis.com/mcp/v1';

function enabled(): boolean {
  const raw = process.env.GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

async function currentAccessToken(ctx: ToolContext): Promise<string> {
  const direct = ctx.authClient?.credentials?.access_token;
  if (typeof direct === 'string' && direct) return direct;
  if (typeof ctx.authClient?.getAccessToken === 'function') {
    const resolved = await ctx.authClient.getAccessToken();
    if (typeof resolved === 'string' && resolved) return resolved;
    if (resolved && typeof resolved.token === 'string' && resolved.token) return resolved.token;
  }
  throw new Error('No Google OAuth access token is available for the first-party Drive MCP fallback.');
}

function asToolResult(result: any): ToolResult {
  return {
    ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    content: Array.isArray(result?.content) ? result.content : [{ type: 'text', text: JSON.stringify(result ?? null) }],
    isError: Boolean(result?.isError),
  };
}

export async function callGoogleFirstPartyDriveTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!enabled()) throw new Error('Google first-party Drive MCP fallback is disabled. Set GOOGLE_DRIVE_FIRST_PARTY_MCP_FALLBACK=true after enabling drivemcp.googleapis.com in the OAuth project.');
  const token = await currentAccessToken(ctx);
  const endpoint = process.env.GOOGLE_DRIVE_FIRST_PARTY_MCP_URL?.trim() || DEFAULT_GOOGLE_DRIVE_MCP_URL;
  const client = new Client({ name: 'nick-drive-fallback', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = Math.max(1000, Math.min(Number(process.env.GOOGLE_DRIVE_FIRST_PARTY_MCP_TIMEOUT_MS || 10000), 120000));
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Google first-party Drive MCP timed out after ${timeoutMs}ms.`)), timeoutMs);
    });
    await Promise.race([client.connect(transport), timeout]);
    const result = await Promise.race([client.callTool({ name, arguments: args }), timeout]);
    return asToolResult(result);
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

export async function tryGoogleFirstPartyDriveTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult | null> {
  if (!enabled()) return null;
  try {
    return await callGoogleFirstPartyDriveTool(ctx, name, args);
  } catch (error) {
    ctx.log('Google first-party Drive MCP fallback unavailable; using local implementation', {
      tool: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
