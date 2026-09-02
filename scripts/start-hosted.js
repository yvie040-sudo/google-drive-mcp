#!/usr/bin/env node

import { spawn } from 'node:child_process';

function firstDomain(raw) {
  return String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .find(Boolean);
}

export function resolveHostedEnvironment(source = process.env) {
  const port = source.MCP_HTTP_PORT || source.PORT || '3100';
  const host = source.MCP_HTTP_HOST || '0.0.0.0';
  const replitDomain = firstDomain(source.REPLIT_DOMAINS);
  const issuerUrl = source.MCP_TEAM_ISSUER_URL || (replitDomain ? `https://${replitDomain}` : undefined);

  if (!issuerUrl) {
    throw new Error(
      'Hosted team mode needs MCP_TEAM_ISSUER_URL, or REPLIT_DOMAINS on Replit so the issuer can be derived safely.',
    );
  }

  const env = {
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

export function runHosted() {
  let env;
  try {
    env = resolveHostedEnvironment(process.env);
  } catch (error) {
    console.error(`Hosted startup configuration error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const child = spawn(process.execPath, ['dist/index.js', 'start'], {
    stdio: 'inherit',
    env,
  });

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

const invokedDirectly = process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) runHosted();
