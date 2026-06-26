import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { IntrospectionClient, authorize } from './auth.js';
import { RateLimiter } from './rate-limit.js';
import { AuditEmitter } from './audit.js';
import type { AuthenticatedPrincipal } from './types.js';

const cfg = loadConfig();
const introspector = new IntrospectionClient(cfg);
const limiter = new RateLimiter();
const audit = new AuditEmitter(cfg);

const app = new Hono();

/** Public base URL of this resource, derived from the proxy's forwarded host. */
function publicBaseUrl(c: Context): string {
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '';
  const proto = c.req.header('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}`;
}

// Health check — never auth-gated
app.get('/health', (c) => c.json({ ok: true, server: cfg.serverSlug }));

// OAuth 2.1 Protected Resource Metadata (RFC 9728). Served UN-gated so MCP
// clients (Claude Code/Desktop) can discover that this resource is protected
// by Keystone and start the browser Authorization-Code + PKCE flow against
// Keystone directly (Keystone is a full OAuth 2.1 AS: authorization_code +
// PKCE + dynamic client registration). The 401 below advertises this document
// via WWW-Authenticate. Both the bare well-known path and the resource-suffixed
// form (.../oauth-protected-resource/mcp) are handled, per the MCP auth spec.
function protectedResourceMetadata(c: Context): Response {
  const base = publicBaseUrl(c);
  return c.json({
    resource: `${base}/mcp`,
    authorization_servers: [cfg.keystoneUrl.replace(/\/$/, '')],
    scopes_supported: [`mcp:${cfg.serverSlug}`],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://identity.alterspective.com.au',
  });
}
app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
app.get('/.well-known/oauth-protected-resource/*', protectedResourceMetadata);

/** 401 helper that points clients at the resource-metadata document (RFC 9728). */
function unauthorized(c: Context, message: string): Response {
  c.header(
    'WWW-Authenticate',
    `Bearer resource_metadata="${publicBaseUrl(c)}/.well-known/oauth-protected-resource"`,
  );
  return c.json({ error: message }, 401);
}

// Strip any inbound X-User-* / X-Pat-* headers so callers can't forge identity
app.use('*', async (c, next) => {
  for (const header of [...c.req.raw.headers.keys()]) {
    if (
      header.toLowerCase().startsWith('x-user-') ||
      header.toLowerCase().startsWith('x-pat-')
    ) {
      c.req.raw.headers.delete(header);
    }
  }
  await next();
});

// Origin gate (CORS-ish — but for MCP clients we mostly just verify origin if present)
app.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && cfg.allowedOrigins.length > 0 && !cfg.allowedOrigins.includes(origin)) {
    return c.json({ error: 'Origin not allowed' }, 403);
  }
  await next();
});

// Main proxy handler
app.all('*', async (c) => {
  // Skip /health (already returned above)
  const requestId = c.req.header('x-request-id') ?? randomUUID();
  const startedAt = Date.now();

  const authHeader = c.req.header('authorization');
  if (!authHeader?.toLowerCase().startsWith('bearer ')) {
    return unauthorized(c, 'Missing bearer token');
  }
  const token = authHeader.slice(7).trim();

  let principal: AuthenticatedPrincipal;
  try {
    const result = await introspector.introspect(token);
    const decision = authorize(result, cfg);
    if (!decision.ok) {
      const status = decision.failure.status as 401 | 403;
      if (status === 401) {
        return unauthorized(c, decision.failure.message);
      }
      return c.json({ error: decision.failure.message }, status);
    }
    principal = decision.principal;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth] introspection error', err);
    return c.json({ error: 'Auth backend unavailable' }, 503);
  }

  // Rate limit
  const rl = limiter.check(principal.ownerId, principal.rateLimitRpm);
  if (!rl.allowed) {
    c.header('Retry-After', String(Math.ceil((rl.retryAfterMs ?? 1000) / 1000)));
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }

  // Build upstream request (path + query, preserving everything after the path)
  const upstreamHeaders = new Headers(c.req.raw.headers);
  upstreamHeaders.delete('host');
  // Replace the caller's PAT with the upstream's own bearer (if configured) so
  // the upstream MCP server's existing auth check passes. Identity for
  // per-user audit + authz still flows via X-User-* headers below.
  // Without MCP_UPSTREAM_BEARER set, the original Authorization is passed
  // through (useful for upstreams that natively trust X-User-* headers).
  if (cfg.upstreamBearer) {
    upstreamHeaders.set('Authorization', `Bearer ${cfg.upstreamBearer}`);
  }
  upstreamHeaders.set('X-User-OID', principal.ownerId);
  upstreamHeaders.set('X-User-Email', principal.ownerEmail);
  upstreamHeaders.set('X-User-Scopes', principal.scopes.join(','));
  upstreamHeaders.set('X-Request-Id', requestId);

  const upstreamUrl = `${cfg.upstreamUrl}${c.req.path}${c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : ''}`;

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: c.req.method,
      headers: upstreamHeaders,
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
      // Node fetch needs duplex: 'half' to stream a request body. The TS lib
      // may or may not include it depending on @types/node version, so cast.
      ...({ duplex: 'half' } as Record<string, unknown>),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[proxy] upstream error', err);
    return c.json({ error: 'Upstream unavailable' }, 502);
  }

  // Audit (fire-and-forget; SSE streaming events log on connect, not per chunk)
  audit.enqueue({
    ts: new Date().toISOString(),
    userOid: principal.ownerId,
    userEmail: principal.ownerEmail,
    serverSlug: cfg.serverSlug,
    method: c.req.method,
    path: c.req.path,
    statusCode: upstreamRes.status,
    latencyMs: Date.now() - startedAt,
    ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim(),
    userAgent: c.req.header('user-agent'),
    requestId,
  });

  // Stream upstream response back
  const respHeaders = new Headers(upstreamRes.headers);
  respHeaders.set('X-Request-Id', requestId);
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: respHeaders,
  });
});

const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`MCP auth sidecar for [${cfg.serverSlug}] listening on :${info.port} → ${cfg.upstreamUrl}`);
  if (cfg.mockAuth) {
    // eslint-disable-next-line no-console
    console.warn('[WARN] MOCK_AUTH_OID is set — Keystone introspection is bypassed. Local dev only.');
  }
});

// Graceful shutdown — flush audit buffer
async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[shutdown] received ${signal}, flushing audit buffer...`);
  await audit.shutdown();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
