import type { Config } from './config.js';
import type { IntrospectionResult, AuthenticatedPrincipal } from './types.js';

interface CacheEntry {
  result: IntrospectionResult;
  expiresAt: number;
}

export class IntrospectionClient {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly cfg: Config) {}

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

    const res = await fetch(`${this.cfg.keystoneUrl}/api/auth/introspect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.keystoneServiceToken}`,
      },
      body: JSON.stringify({ token }),
    });

    if (!res.ok) {
      // Treat upstream errors as a hard fail — do NOT cache as "valid"
      throw new Error(`Introspection failed: ${res.status}`);
    }

    const result = (await res.json()) as IntrospectionResult;

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

  // Privileged-scope enforcement is handled at PAT *issuance* by Keystone via
  // self_service_scopes.requires_admin (migration 010). If a scope is in the
  // PAT, the user already passed the admin gate. The sidecar deliberately does
  // not re-check admin status — Keystone introspection does not return it.

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
