# Implementation checklist

This scaffold is functional but unfinished. Below is what an AI/engineer should do next, in order.

## Phase 1 — make it actually work

- [ ] `npm install` and verify `npm run build` succeeds with no TS errors
- [ ] Resolve the `c.req.url.split(c.req.path)[1]` quirk in `src/server.ts` — works for most cases but verify against MCP path patterns (`/mcp`, `/sse`, `/mcp/<id>`)
- [ ] Add a basic test in `tests/auth.test.ts` covering `authorize()`: missing scope → 403, no admin → 403 when required, valid → ok
- [ ] Add a basic test in `tests/rate-limit.test.ts` for the token bucket (allowed under limit, denied over, retry-after correct)
- [ ] Smoke test locally with `MOCK_AUTH_OID` against a real local MCP server (start cortex-mcp on localhost, point sidecar at it, send a tool call)

## Phase 2 — verify SSE works end-to-end

- [ ] Test SSE proxying with cortex-mcp (the pilot target — uses SSE transport)
- [ ] Confirm long-lived SSE connections don't leak audit events (audit fires once on connect, not per chunk)
- [ ] Confirm client disconnects propagate cleanly (Node `fetch` AbortController behavior with streaming)
- [ ] Document any SSE limitations discovered

## Phase 3 — production hardening

- [ ] Replace `console.log/error` with a real structured logger (pino or similar)
- [ ] Add a `/metrics` endpoint (Prometheus format) for cache hit rate, RPM per user, audit buffer depth
- [ ] Implement audit event drop policy if buffer exceeds N (currently grows unbounded on Keystone outage)
- [ ] Negative-cache the *token* even when introspection returns 5xx? (Currently throws, which means clients retry — could be DDoS amplification)
- [ ] Decide what happens when Keystone is down for >5 minutes — fail-closed (current) vs degraded mode

## Phase 4 — first real deploy

- [ ] Deploy in front of `cortex-mcp` on Coolify (Phase 1 pilot per master plan)
- [ ] Issue a Keystone service token with `auth:introspect` scope
- [ ] Verify Keystone wave-7 is shipped (`/api/auth/introspect` returns 200, not 404)
- [ ] Verify Keystone has a `/api/audit/mcp-events` endpoint (built as part of master plan Phase 1)
- [ ] Configure Caddy to point `cortex-mcp.alterspective.com.au` at the sidecar port
- [ ] Bind cortex-mcp itself to `127.0.0.1` so it can only be reached via the sidecar
- [ ] End-to-end smoke: Igor logs into Keystone, generates a PAT scoped `mcp:cortex`, configures Claude Desktop, makes a tool call, sees it appear in the Keystone audit log

## Known unfinished pieces

- **`/api/audit/mcp-events` endpoint in Keystone does not exist yet** — Keystone wave 7 shipped 2026-05-06 with PAT self-service + introspection, but the audit-sink endpoint is not part of it. Sidecar will log errors and re-enqueue indefinitely until that endpoint exists. Either: (a) add to a Keystone wave-7 follow-up, or (b) point sidecar at a different audit sink (Loki, Postgres direct, syslog) — see "open question" below.

### Recent contract alignments (2026-05-06)

The sidecar code was reconciled with the actual Keystone wave-7 introspection contract:

- Removed `IntrospectionResult.isAdmin` and `IntrospectionResult.patId` — Keystone deliberately omits both (token-enumeration oracle prevention; admin enforcement happens at issuance via `self_service_scopes.requires_admin`)
- Removed the `REQUIRES_ADMIN` env var and `cfg.requiresAdmin && !result.isAdmin` check
- Removed `X-User-Is-Admin` and `X-Pat-Id` from the upstream header contract
- Added `expiresAt` to `IntrospectionResult` (Keystone returns it)
- Note: the registry table that backs PAT scope validation in Keystone was renamed `mcp_servers` → `self_service_scopes` in migration 010 (now multi-namespace, also serves `gpaas:*` scopes for cowork-onboarding). Sidecar is namespace-agnostic — no change needed, but keep this in mind when reading older docs.
- **No tests for the proxy path itself** (the most complex code) — needs a mock upstream server.
- **No graceful handling of the SSE keep-alive case** — if client disconnects mid-stream, upstream connection should close.
- **Cache eviction is FIFO (`Map.keys().next()`)** — fine for v1 but not LRU; if cache pressure becomes a real issue, swap for `lru-cache`.
- **No health check on Keystone availability** — sidecar starts even if Keystone is unreachable; first request will 503.

## References

- Master plan: `C:\GitHub\alterspective-keystone\docs\plans\mcp-gateway-and-pat-self-service-plan.md`
- Keystone PAT packet: `C:\GitHub\alterspective-keystone\docs\waves\wave-7-mcp-pat-self-service.md`
- Sidecar AGENTS.md: `../AGENTS.md`
