/**
 * Contract between sidecar and Keystone /api/auth/introspect.
 *
 * Keystone deliberately omits `isAdmin` and any token-enumeration signals
 * (revoked/expired/unknown collapse to `not_found`). Privileged-scope
 * enforcement happens at PAT *issuance* via `self_service_scopes.requires_admin`,
 * not at introspection. If a scope is in the PAT, the user already passed the
 * issuance gate.
 */
export interface IntrospectionResult {
  valid: boolean;
  reason?: 'not_found';
  ownerType?: 'user' | 'service';
  ownerId?: string;
  ownerEmail?: string | null;
  scopes?: string[];
  rateLimitRpm?: number | null;
  expiresAt?: string | null;
}

export interface AuthenticatedPrincipal {
  ownerId: string;
  ownerEmail: string;
  scopes: string[];
  rateLimitRpm: number;
}

export interface AuditEvent {
  ts: string;
  userOid: string;
  userEmail: string;
  serverSlug: string;
  method: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  ip?: string;
  userAgent?: string;
  requestId: string;
}
