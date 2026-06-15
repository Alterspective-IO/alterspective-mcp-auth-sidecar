import { describe, expect, it, vi, beforeEach } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { IntrospectionClient, authorize } from './auth.js';
import type { Config } from './config.js';

describe('MCP Auth Sidecar JWT and PAT validation', () => {
  const cfg: Config = {
    port: 4000,
    serverSlug: 'test-server',
    requiredScope: 'mcp:test-server',
    upstreamUrl: 'http://localhost:5000',
    keystoneUrl: 'http://localhost:4400',
    keystoneServiceToken: 'service-token',
    allowedOrigins: [],
    introspectCacheTtlMs: 1000,
    introspectNegativeCacheTtlMs: 1000,
    auditBatchSize: 10,
    auditFlushIntervalMs: 1000,
    isProduction: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates a correct JWT locally', async () => {
    // Generate temporary key pair for signing the JWT
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });

    // Stub fetch to return the mock JWKS
    const jwk = await exportJWK(publicKey);
    const mockJwks = {
      keys: [{ ...jwk, kid: 'test-kid', alg: 'RS256', use: 'sig' }],
    };

    const fetchMock = vi.fn().mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.endsWith('/.well-known/jwks.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => mockJwks,
        };
      }
      return { ok: false, status: 404 };
    });
    global.fetch = fetchMock as any;

    const token = await new SignJWT({
      scope: 'mcp:test-server',
      email: 'user@example.com',
      role: 'authenticated',
      entra_oid: 'oid-123',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer('http://localhost:4400')
      .setAudience('http://localhost:4400/api/mcp')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const client = new IntrospectionClient(cfg);
    const result = await client.introspect(token);

    expect(result.valid).toBe(true);
    expect(result.ownerId).toBe('oid-123');
    expect(result.ownerEmail).toBe('user@example.com');
    expect(result.scopes).toContain('mcp:test-server');

    const decision = authorize(result, cfg);
    expect(decision.ok).toBe(true);
  });

  it('falls back to remote introspection for a PAT (non-JWT)', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url) => {
      if (url.endsWith('/api/auth/introspect')) {
        return {
          ok: true,
          json: async () => ({
            valid: true,
            ownerType: 'user',
            ownerId: 'oid-pat-123',
            ownerEmail: 'pat-user@example.com',
            scopes: ['mcp:test-server'],
          }),
        };
      }
      return { ok: false, status: 404 };
    });
    global.fetch = fetchMock;

    const client = new IntrospectionClient(cfg);
    const result = await client.introspect('ks_member_pat_xyz');

    expect(result.valid).toBe(true);
    expect(result.ownerId).toBe('oid-pat-123');
    expect(result.ownerEmail).toBe('pat-user@example.com');
    expect(result.scopes).toContain('mcp:test-server');
  });
});
