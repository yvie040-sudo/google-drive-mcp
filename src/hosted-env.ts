function firstDomain(raw: string | undefined): string | undefined {
  return String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .find(Boolean);
}

/**
 * Resolve production HTTP/team-mode variables without mutating the caller's
 * environment. Keeping this in TypeScript means normal build and test build use
 * exactly the same typed contract, while the small launcher remains plain Node.
 */
export function resolveHostedEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const port = source.MCP_HTTP_PORT || source.PORT || '3100';
  const host = source.MCP_HTTP_HOST || '0.0.0.0';
  const replitDomain = firstDomain(source.REPLIT_DOMAINS);
  const issuerUrl =
    source.MCP_TEAM_ISSUER_URL ||
    (replitDomain ? `https://${replitDomain}` : undefined);

  if (!issuerUrl) {
    throw new Error(
      'Hosted team mode needs MCP_TEAM_ISSUER_URL, or REPLIT_DOMAINS on Replit so the issuer can be derived safely.',
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...source,
    MCP_TRANSPORT: 'http',
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_HOST: host,
    MCP_TEAM_MODE: 'true',
    MCP_TEAM_ISSUER_URL: issuerUrl,
  };

  if (source.REPLIT_DEPLOYMENT === '1' && !source.MCP_TRUST_PROXY) {
    env.MCP_TRUST_PROXY = '1';
  }

  return env;
}
