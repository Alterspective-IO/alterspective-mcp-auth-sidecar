# Alterspective MCP Auth Sidecar

Reverse-proxy sidecar that adds per-user authentication, audit, and rate-limiting in front of an Alterspective MCP server. Staff authenticate with Personal Access Tokens (PATs) from Keystone instead of shared API keys.

See `AGENTS.md` for canonical guidance.

## Quick start (local dev)

```bash
npm install
cp .env.example .env
# Edit .env — set MOCK_AUTH_OID for local dev (only allowed when NODE_ENV != production)
npm run dev
```

Sidecar listens on `SIDECAR_PORT` and proxies authenticated requests to `MCP_UPSTREAM_URL`.

## Deploying in front of an MCP server

In the MCP server's Coolify project:

1. Add this sidecar as a second container in the same project
2. Bind the MCP server to `127.0.0.1:NNNN` (not `0.0.0.0`)
3. Set sidecar env: `MCP_UPSTREAM_URL=http://127.0.0.1:NNNN`, `MCP_SERVER_SLUG=<slug>`
4. Point Caddy at the sidecar port, not the MCP server port
5. Issue a Keystone service token with `auth:introspect` scope; set as `KEYSTONE_SERVICE_TOKEN`

## Status

Draft scaffolding. Phase 1 pilot target: `cortex-mcp`. Not yet production-deployed.

## Master plan

`C:\GitHub\alterspective-keystone\docs\plans\mcp-gateway-and-pat-self-service-plan.md`
