# Alterspective MCP Auth Sidecar

Reverse-proxy sidecar that adds per-user authentication, audit, and rate-limiting in front of an Alterspective MCP server. Staff authenticate with Personal Access Tokens (PATs) from Keystone instead of shared API keys.

See `AGENTS.md` for canonical guidance.

## Status

✅ **First pilot live in production**: `https://sharedo-mcp.alterspective.com.au` is fronted by an instance of this sidecar (Coolify app `r34g3l0j4crxgnxk765f9q17`, gptprompts-prod VPS). End-to-end smoke verified — PATs validate against Keystone, scope checks enforce, upstream-bearer swap forwards to sharedo-mcp, audit rows land in `mcp_audit_log` keyed to the caller's real OID + email.

Sidecar code is feature-complete for the v1 pattern. Outstanding work tracked in `docs/implementation-checklist.md`.

## Quick start (local dev)

```bash
npm install
cp .env.example .env
# Edit .env — set MOCK_AUTH_OID for local dev (only allowed when NODE_ENV != production)
npm run dev
```

Sidecar listens on `SIDECAR_PORT` and proxies authenticated requests to `MCP_UPSTREAM_URL`.

## Deploying in front of an MCP server

The deployment shape depends on what the upstream MCP server runs on. Sharedo (the first pilot) is a Coolify-managed app on `gptprompts-prod` — the playbook for that pattern is in `C:\GitHub\ai-office\docs\implementation\current\mcp-gateway-rollout\HANDOVER-2026-05-10.md`.

For a Coolify-fronted upstream:

1. Create a new Coolify app from this repo (public, dockerfile build pack, port 4000)
2. Put it on the same server as the upstream MCP server, on the `coolify` docker network
3. Set sidecar env vars (see `.env.example`):
   - `MCP_SERVER_SLUG=<slug>` (matches `mcp:<slug>` scope on PATs)
   - `MCP_UPSTREAM_URL=http://<upstream-container>:<port>` (docker-network internal)
   - `MCP_UPSTREAM_BEARER=<vault-stored-key>` if upstream has its own bearer auth
   - `KEYSTONE_URL=https://identity.alterspective.com.au`
   - `KEYSTONE_SERVICE_TOKEN=<minted-via-DB-insert-or-admin-UI>`
4. Deploy. Smoke internally first. Then cut over the public FQDN from upstream Coolify app to sidecar Coolify app via Coolify's domain-edit API + redeploy both.

For a direct-VPS upstream (cortex, vault-mcp, etc.) the playbook is different and not yet documented — first instance is on the next-pilot todo.

## Master plan

`C:\GitHub\alterspective-keystone\docs\plans\mcp-gateway-and-pat-self-service-plan.md`
