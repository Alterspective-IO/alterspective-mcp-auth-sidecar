# Implementation checklist

Started as a forward-looking scaffold. After the sharedo pilot landed in production (2026-05-09), this is now a hybrid done-list / known-gaps record.

## Phase 1 — make it work

- [x] `npm install` and `npm run build` clean (after fix `8af8269` for two TS strict-mode errors)
- [x] Path-handling quirk in `src/server.ts` resolved (the dead `const url = new URL(...)` line was removed; `upstreamUrl` is built directly from `c.req.path` + query string)
- [x] Smoke test against a real upstream — done end-to-end against sharedo-mcp via the sidecar's mock-auth path locally and via real Keystone introspection in production
- [ ] Unit tests on `authorize()` (missing scope → 403, valid → ok) — **still TODO** (sidecar shipped without tests; production smoke covers behaviour but tests would catch regressions)
- [ ] Unit tests on rate-limit token bucket — **still TODO**

## Phase 2 — verify SSE

- [x] HTTP transport tested end-to-end (sharedo-mcp uses HTTP not SSE; production audit rows confirm the proxy passes data correctly)
- [ ] **SSE transport untested** — sharedo is HTTP. Cortex would have been the SSE pilot but isn't on Coolify, so SSE remains untested in production. First SSE-using upstream sidecared will be the real test
- [ ] SSE keep-alive / disconnect propagation — untested for the same reason

## Phase 3 — production hardening

- [ ] Replace `console.log/error` with a structured logger (pino or similar). Currently console-only.
- [ ] `/metrics` endpoint (Prometheus format) for cache hit rate, RPM per user, audit buffer depth
- [ ] Audit-event drop policy if buffer exceeds N (currently grows unbounded on Keystone outage; bounded only by process memory)
- [ ] Negative-cache strategy on introspection 5xx (currently throws → clients retry → potential DDoS amplification)
- [ ] Documented behaviour for Keystone-down >5min (currently fail-closed; may want a degraded mode)
- [ ] LRU cache eviction (currently FIFO via `Map.keys().next()`; fine for v1, swap for `lru-cache` if pressure shows)
- [ ] Health check on Keystone availability at sidecar startup (currently starts even if Keystone unreachable; first request will 503)

## Phase 4 — first real deploy ✅ DONE (sharedo, 2026-05-09)

Different shape than originally planned (cortex was the original target but isn't on Coolify):

- [x] Wave 7 (PAT self-service) shipped to Keystone prod
- [x] Wave 7.1 (data-driven scope registry) shipped (commit `01b1f75`)
- [x] Wave 8 (`/api/audit/mcp-events` endpoint + migration 011 `mcp_audit_log` + RLS) shipped
- [x] Service token issued for sidecar (`mcp-sidecar-sharedo--keystone-service-token` in vault) — minted via direct DB insert using the same SHA-256(key+pepper) crypto the route uses
- [x] Sidecar Coolify app created and deployed (`r34g3l0j4crxgnxk765f9q17`) on gptprompts-prod
- [x] FQDN cutover: `sharedo-mcp.alterspective.com.au` removed from sharedo Coolify app's FQDN list, added to sidecar's
- [x] End-to-end smoke with real PAT — sidecar accepts → introspects → scope-checks → swaps Authorization for upstream bearer → forwards → audit row appears in `mcp_audit_log` keyed to caller's OID

## Recent contract alignments (2026-05-06 → 2026-05-09)

The sidecar code was reconciled with the actual Keystone wave-7 introspection contract:

- Removed `IntrospectionResult.isAdmin` and `IntrospectionResult.patId` — Keystone deliberately omits both (token-enumeration oracle prevention; admin enforcement happens at issuance via `self_service_scopes.requires_admin`)
- Removed the `REQUIRES_ADMIN` env var and `cfg.requiresAdmin && !result.isAdmin` check
- Removed `X-User-Is-Admin` and `X-Pat-Id` from the upstream header contract
- Added `expiresAt` to `IntrospectionResult` (Keystone returns it)
- Added `MCP_UPSTREAM_BEARER` env var (commit `7378320`) — sidecar swaps caller's PAT for upstream's legacy bearer when the upstream has its own static-key auth (sharedo case). X-User-* still flows.
- Audit event field renamed `server` → `serverSlug` (matches Keystone wave-8 schema)

The registry table that backs PAT scope validation in Keystone was renamed `mcp_servers` → `self_service_scopes` in migration 010 (now multi-namespace, also serves `gpaas:*` scopes for cowork-onboarding). Sidecar is namespace-agnostic — no change needed here.

## Known gaps (not blockers for v1, real for fleet expansion)

- **No unit tests** — sidecar shipped on production smoke alone. Real risk of regression if anyone touches `authorize()` or the rate limiter. Prioritize before the second pilot.
- **No SSE production validation** — see Phase 2. First SSE-using upstream sidecared (probably prompts-mcp or cortex when reached) will be the real test; might surface bugs.
- **Direct-VPS deployment pattern unbuilt** — the only documented deployment is Coolify-FQDN-cutover (sharedo). Cortex, vault, ms365 etc. need a different playbook (manual docker-compose + reverse proxy edits). First instance not yet built.

## References

- Master plan: `C:\GitHub\alterspective-keystone\docs\plans\mcp-gateway-and-pat-self-service-plan.md`
- Keystone PAT packet: `C:\GitHub\alterspective-keystone\docs\waves\wave-7-mcp-pat-self-service.md`
- Wave 8 audit-sink: `C:\GitHub\alterspective-keystone\docs\waves\wave-8-mcp-audit-sink.md`
- Sharedo pilot handover: `C:\GitHub\ai-office\docs\implementation\current\mcp-gateway-rollout\HANDOVER-2026-05-10.md`
- Sidecar AGENTS.md: `../AGENTS.md`
