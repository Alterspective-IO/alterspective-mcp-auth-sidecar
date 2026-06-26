import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Config } from './config.js';
import type { IntrospectionResult, AuthenticatedPrincipal } from './types.js';

interface CacheEntry {
  result: IntrospectionResult;
  expiresAt: number;
}

function extractScopes(payload: any): string[] {
  const rawScopes = new Set<string>();

  const scope = payload.scope;
  if (typeof scope === 'string') {
    for (const item of scope.split(/\s+/)) {
      if (item) rawScopes.add(item);
    }
  }

  const scp = payload.scp;
  if (typeof scp === 'string') {
    for (const item of scp.split(/\s+/)) {
      if (item) rawScopes.add(item);
    }
  } else if (Array.isArray(scp)) {
    for (const item of scp) {
      if (typeof item === 'string') rawScopes.add(item);
    }
  }

  const scopes = payload.scopes;
  if (Array.isArray(scopes)) {
    for (const item of scopes) {
      if (typeof item === 'string') rawScopes.add(item);
    }
  }

  return Array.from(rawScopes);
}

export class IntrospectionClient {
  private cache = new Map<string, CacheEntry>();
  private jwkSet: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly cfg: Config) {}

  private getJwkSet(): ReturnType<typeof createRemoteJWKSet> {
    if (!this.jwkSet) {
      const jwksUrl = new URL(`${this.cfg.keystoneUrl.replace(/\/$/, '')}/.well-known/jwks.json`);
      this.jwkSet = createRemoteJWKSet(jwksUrl);
    }
    return this.jwkSet;
  }

  async introspect(token: string): Promise<IntrospectionResult> {
    if (this.cfg.mockAuth) {
      return {
        valid: true,
        ownerType: 'user',
        ownerId: this.cfg.mockAuth.oid,
        ownerEmail: this.cfg.mockAuth.email,
        scopes: [this.cfg.requiredScope],
        rateLimitRpm: 60,
        expiresAt: null,
      };
    }

    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    let result: IntrospectionResult;

    if (token.includes('.')) {
      // It is a JWT access token, validate it locally
      try {
        const { payload } = await jwtVerify(token, this.getJwkSet());

        // Validate issuer
        const iss = payload.iss;
        const expectedIssuers = [
          this.cfg.keystoneUrl.replace(/\/$/, ''),
          'https://identity.alterspective.com.au',
          'http://localhost:4400'
        ];
        if (!iss || !expectedIssuers.includes(iss)) {
          result = { valid: false, reason: 'not_found' };
        } else {
          // Validate audience/resource
          const aud = payload.aud;
          const auds = Array.isArray(aud) ? aud : [aud];
          const expectedResources = [
            `${this.cfg.keystoneUrl.replace(/\/$/, '')}/api/mcp`,
            'https://identity.alterspective.com.au/api/mcp',
            'http://localhost:4400/api/mcp'
          ];
          const hasValidAudience = auds.some((a) => a && expectedResources.includes(a));

          if (!hasValidAudience) {
            result = { valid: false, reason: 'not_found' };
          } else {
            const scopes = extractScopes(payload);
            const ownerId = typeof payload.entra_oid === 'string' ? payload.entra_oid : (typeof payload.sub === 'string' ? payload.sub : undefined);
            const ownerEmail = typeof payload.email === 'string' ? payload.email : null;
            const ownerType = payload.role === 'authenticated' ? 'user' : 'service';

            if (!ownerId) {
              result = { valid: false, reason: 'not_found' };
            } else {
              result = {
                valid: true,
                ownerType,
                ownerId,
                ownerEmail,
                scopes,
                rateLimitRpm: typeof payload.rateLimitRpm === 'number' ? payload.rateLimitRpm : 60,
                expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null,
              };
            }
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[auth] JWT verification failed:', err);
        result = { valid: false, reason: 'not_found' };
      }
    } else {
      // It is a PAT/API key, use the introspection endpoint
      const res = await fetch(`${this.cfg.keystoneUrl}/api/auth/introspect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.keystoneServiceToken}`,
        },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        throw new Error(`Introspection failed: ${res.status}`);
      }

      result = (await res.json()) as IntrospectionResult;
    }

    const ttl = result.valid
      ? this.cfg.introspectCacheTtlMs
      : this.cfg.introspectNegativeCacheTtlMs;
    this.cache.set(token, { result, expiresAt: Date.now() + ttl });

    // Bound cache size to prevent unbounded growth
    if (this.cache.size > 10_000) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    return result;
  }

  invalidate(token: string): void {
    this.cache.delete(token);
  }
}

export interface AuthorizationFailure {
  status: number;
  message: string;
}

export function authorize(
  result: IntrospectionResult,
  cfg: Config
): { ok: true; principal: AuthenticatedPrincipal } | { ok: false; failure: AuthorizationFailure } {
  if (!result.valid) {
    return { ok: false, failure: { status: 401, message: `Invalid token (${result.reason ?? 'unknown'})` } };
  }
  if (!result.ownerId || !result.scopes) {
    return { ok: false, failure: { status: 401, message: 'Malformed introspection response' } };
  }
  if (!result.scopes.includes(cfg.requiredScope)) {
    return {
      ok: false,
      failure: { status: 403, message: `Token missing required scope: ${cfg.requiredScope}` },
    };
  }

  return {
    ok: true,
    principal: {
      ownerId: result.ownerId,
      ownerEmail: result.ownerEmail ?? '',
      scopes: result.scopes,
      rateLimitRpm: result.rateLimitRpm ?? 60,
    },
  };
}
