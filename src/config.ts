interface Config {
  port: number;
  serverSlug: string;
  requiredScope: string;
  upstreamUrl: string;
  upstreamBearer?: string;
  keystoneUrl: string;
  keystoneServiceToken: string;
  allowedOrigins: string[];
  introspectCacheTtlMs: number;
  introspectNegativeCacheTtlMs: number;
  auditBatchSize: number;
  auditFlushIntervalMs: number;
  isProduction: boolean;
  mockAuth?: { oid: string; email: string };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optionalInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export function loadConfig(): Config {
  const isProduction = process.env.NODE_ENV === 'production';
  const serverSlug = required('MCP_SERVER_SLUG');

  let mockAuth: Config['mockAuth'];
  if (process.env.MOCK_AUTH_OID) {
    if (isProduction) {
      throw new Error('MOCK_AUTH_OID is forbidden in production');
    }
    mockAuth = {
      oid: process.env.MOCK_AUTH_OID,
      email: process.env.MOCK_AUTH_EMAIL ?? 'dev@alterspective.com.au',
    };
  }

  return {
    port: optionalInt('SIDECAR_PORT', 4000),
    serverSlug,
    requiredScope: `mcp:${serverSlug}`,
    upstreamUrl: required('MCP_UPSTREAM_URL').replace(/\/$/, ''),
    upstreamBearer: process.env.MCP_UPSTREAM_BEARER || undefined,
    keystoneUrl: required('KEYSTONE_URL').replace(/\/$/, ''),
    keystoneServiceToken: mockAuth ? '' : required('KEYSTONE_SERVICE_TOKEN'),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    introspectCacheTtlMs: optionalInt('INTROSPECT_CACHE_TTL_MS', 60_000),
    introspectNegativeCacheTtlMs: optionalInt('INTROSPECT_NEGATIVE_CACHE_TTL_MS', 10_000),
    auditBatchSize: optionalInt('AUDIT_BATCH_SIZE', 20),
    auditFlushIntervalMs: optionalInt('AUDIT_FLUSH_INTERVAL_MS', 5_000),
    isProduction,
    mockAuth,
  };
}

export type { Config };
