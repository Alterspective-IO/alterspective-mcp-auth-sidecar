# AGENTS.md - Alterspective MCP Auth Sidecar

Global rules from `C:\GitHub\AGENTS.md` apply here. This file is the canonical instruction source for AI tools working in this repository.

`CLAUDE.md` and `GEMINI.md` in this repo are thin wrappers that import this file.

## What this is

A small reverse-proxy sidecar that sits in front of each Alterspective MCP server. Staff connect their AI tools (Claude Desktop, Claude Code, Codex, Gemini) to MCP servers using **Personal Access Tokens (PATs) issued by Keystone**, not shared API keys. This sidecar validates those PATs, injects per-user identity headers, audits every call, and rate-limits per user.

**Why it exists:** Today the deployed MCP servers (`ms365-mcp`, `sharedo-mcp`, `cortex-mcp`, etc.) all use a single shared API key per server — no per-user identity, no per-user audit, no per-user revocation. This sidecar fixes that without modifying each MCP server individually.

## Topology

```
Staff AI client
   │  Authorization: Bearer ks_live_...
   ▼
mcp-server.alterspective.com.au   ◄── public TLS
   │
   ▼
[ this sidecar ]   ◄── port 4000 (configurable)
   │  - validate PAT via Keystone introspection (cached 60s)
   │  - check mcp:<server> scope
   │  - check privileged-scope guards (mcp:vault → admin)
   │  - rate-limit per user
   │  - inject X-User-OID, X-User-Email, X-User-Scopes
   │  - emit audit event to Keystone
   ▼
http://localhost:NNNN/mcp   ◄── the actual MCP server, bound to localhost only
```

The MCP server itself is **unchanged** — it just trusts the `X-User-*` headers from the sidecar and binds to `127.0.0.1` so it cannot be reached directly from the internet.

## Design decisions

- **Per-server deployment, not central gateway.** Each MCP server's Coolify deploy ships with its own sidecar. Avoids a single point of failure and keeps per-server CORS/rate-limit policy isolated.
- **Opaque PAT + introspection RPC.** Calls Keystone `/api/auth/introspect` once per token, caches positive 60s and negative 10s. Adds ~30ms when cache is warm. Trade-off documented in `docs/plans/mcp-gateway-and-pat-self-service-plan.md` in the keystone repo.
- **Stateless sidecar.** No DB, no shared state. All state lives in Keystone or the in-process LRU cache.
- **Hono + Node.** Small, fast, native fetch-based reverse proxy works for both HTTP and SSE transports.
- **Audit events go to Keystone.** Keystone is the platform's audit authority; co-locating MCP events with the rest of the audit log keeps cross-service investigation simple.

## What this sidecar is NOT

- Not a load balancer. One sidecar in front of one MCP server.
- Not a token issuer. Tokens come from Keystone (`/account/tokens` page).
- Not a credential vault. If an MCP server needs upstream API tokens (Timely, Monday), the server handles that itself for now.
- Not a multi-protocol proxy. HTTP and SSE only — no WebSocket support in v1.

## Configuration

All via environment variables. See `.env.example` for the full list.

| Var | Purpose | Required |
|---|---|---|
| `SIDECAR_PORT` | Port the sidecar listens on (public side) | Yes |
| `MCP_SERVER_SLUG` | The slug for this server (`ms365`, `sharedo`, etc.) — drives the required scope `mcp:<slug>` | Yes |
| `MCP_UPSTREAM_URL` | Where to proxy requests to (e.g. `http://127.0.0.1:3001`) | Yes |
| `KEYSTONE_URL` | Keystone base URL (e.g. `https://identity.alterspective.com.au`) | Yes |
| `KEYSTONE_SERVICE_TOKEN` | Service token with `auth:introspect` scope, used to call Keystone | Yes |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins | No (default: deny all) |
| `AUDIT_BATCH_SIZE` | How many audit events to batch before flushing | No (default `20`) |
| `AUDIT_FLUSH_INTERVAL_MS` | Max time between flushes | No (default `5000`) |
| `INTROSPECT_CACHE_TTL_MS` | Positive cache TTL | No (default `60000`) |
| `INTROSPECT_NEGATIVE_CACHE_TTL_MS` | Negative cache TTL | No (default `10000`) |
| `MOCK_AUTH_OID` | Dev-only: skip Keystone, use this OID. Refuses to start in production. | No |

## Header contract (sidecar → MCP server)

The sidecar injects these headers on every proxied request:

| Header | Value |
|---|---|
| `X-User-OID` | Keystone user OID |
| `X-User-Email` | User's email |
| `X-User-Scopes` | Comma-separated scopes from the PAT |
| `X-Request-Id` | Correlation id (generated if not present) |

The MCP server **MUST** trust these headers (they cannot be set by external callers — sidecar strips any inbound `X-User-*` and `X-Pat-*` headers before validation).

### Why no `X-User-Is-Admin` or `X-Pat-Id`

Keystone's introspection contract (wave 7, 2026-05-06) deliberately omits both:

- **No `isAdmin`**: privileged-scope enforcement happens at PAT *issuance* via `self_service_scopes.requires_admin` (migration 010). If `mcp:vault` is in the token, the user already passed the admin gate. Re-checking at the gateway would either require introspection to leak admin status (which it doesn't) or a separate Keystone RPC (extra latency, extra coupling). Trade-off: a user who was admin at issuance but de-admin'd later still has working PATs until they expire or are revoked. Accepted for a 30-person org; revisit if the threat model tightens.
- **No `patId`**: introspection collapses revoked/expired/unknown to `not_found` to remove a token-enumeration oracle, and does not expose internal key ids. If you need per-token correlation in audit logs, log the SHA-256 prefix of the token itself, never the token.

## Rate limiting

Per-user, per-sidecar, in-memory token bucket. Limit is `rateLimitRpm` from introspection response (defaults to 60 if null). On 429, response includes `Retry-After`.

This is per-instance, not cluster-wide. If a single server gets multiple sidecar instances, the effective limit is `instances × rateLimitRpm`. Document this if it matters.

## Anti-fabrication

- Never claim the sidecar is "production-ready" until it has been deployed in front of one real MCP server (cortex-mcp pilot) and tested end-to-end with a real Keystone PAT.
- The introspection contract assumes the Keystone wave-7 work is shipped (`docs/waves/wave-7-mcp-pat-self-service.md` in the keystone repo). If introspection returns 404, that work isn't deployed yet.
- SSE proxying via Node `fetch` is well-supported but has edge cases (timeouts, disconnects). Test the SSE path end-to-end before declaring the sidecar ready for SSE servers (cortex, prompts).

## Standards

- Read `C:\GitHub\GPTPrompts\prompts\05-security-standards.md` before touching auth code
- Follow naming conventions of sibling repos (lowercase-hyphenated files, kebab-case routes)
- TypeScript strict mode; no `any` in auth/audit paths
- Audit log writes are **fire-and-forget** but must not lose events — buffer + flush on shutdown

## Deploy

Built as a Docker image. Each MCP server's Coolify project adds the sidecar as a second container in the same project, with the MCP server bound to `127.0.0.1` and the sidecar exposed via Caddy.

Phase 1 pilot: `cortex-mcp`. See master plan in keystone repo for full rollout.

## Related repos

- `alterspective-keystone` — issues PATs, hosts introspection endpoint, receives audit events
- `ai-office` — ships staff client config (`aio mcp install <server>`) once the registry is built
- `ms365-mcp`, `sharedo-mcp`, `cortex-mcp`, `vault-mcp`, etc. — the MCP servers this sidecar fronts

## Key references

- Master plan: `C:\GitHub\alterspective-keystone\docs\plans\mcp-gateway-and-pat-self-service-plan.md`
- Keystone PAT implementation packet: `C:\GitHub\alterspective-keystone\docs\waves\wave-7-mcp-pat-self-service.md`
- Hono docs: https://hono.dev
