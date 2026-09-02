import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveHostedEnvironment } from '../scripts/start-hosted.js';

describe('hosted launcher', () => {
  it('derives Replit host, port, issuer and trusted proxy safely', () => {
    const env = resolveHostedEnvironment({
      PORT: '4321',
      REPLIT_DOMAINS: 'nick-drive.example.replit.app,secondary.example',
      REPLIT_DEPLOYMENT: '1',
    });
    assert.equal(env.MCP_TRANSPORT, 'http');
    assert.equal(env.MCP_HTTP_PORT, '4321');
    assert.equal(env.MCP_HTTP_HOST, '0.0.0.0');
    assert.equal(env.MCP_TEAM_MODE, 'true');
    assert.equal(env.MCP_TEAM_ISSUER_URL, 'https://nick-drive.example.replit.app');
    assert.equal(env.MCP_TRUST_PROXY, '1');
  });

  it('prefers explicit MCP values over platform fallbacks', () => {
    const env = resolveHostedEnvironment({
      PORT: '4000',
      MCP_HTTP_PORT: '5000',
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_TEAM_ISSUER_URL: 'https://drive.example.com',
      MCP_TRUST_PROXY: '2',
      REPLIT_DOMAINS: 'ignored.replit.app',
      REPLIT_DEPLOYMENT: '1',
    });
    assert.equal(env.MCP_HTTP_PORT, '5000');
    assert.equal(env.MCP_HTTP_HOST, '127.0.0.1');
    assert.equal(env.MCP_TEAM_ISSUER_URL, 'https://drive.example.com');
    assert.equal(env.MCP_TRUST_PROXY, '2');
  });

  it('fails closed without a public issuer', () => {
    assert.throws(
      () => resolveHostedEnvironment({ PORT: '4321' }),
      /MCP_TEAM_ISSUER_URL|REPLIT_DOMAINS/,
    );
  });
});
