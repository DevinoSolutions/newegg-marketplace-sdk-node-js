# example-mcp-http

Run the Newegg MCP server over **Streamable HTTP** using the package's own exported API. This
mirrors the HTTP path of the package `bin` (`newegg-marketplace-mcp --transport http`).

## What it shows

- `loadMcpConfigFromEnv()` → `startHttpServer({ http, writesEnabled, createServer, logger, serverInfo })`,
  where `createServer` builds a fresh `createNeweggMcpServer` per session over one shared
  `InMemoryPreviewStore`, plus graceful shutdown on SIGINT/SIGTERM.
- The HTTP surface: MCP at **`POST /mcp`** (session id in the `Mcp-Session-Id` response
  header) and an unauthenticated **`GET /healthz`**.
- Network safety: the server binds `config.http.host:port` (default `127.0.0.1:3919`) and
  refuses a non-loopback bind, or any start with `NEWEGG_MCP_ALLOW_WRITES=true`, unless
  `NEWEGG_MCP_HTTP_BEARER_TOKEN` is set; `Origin` and `Host` headers are validated on `/mcp`.

## Environment

Required: `NEWEGG_SELLER_ID`, `NEWEGG_API_KEY`, `NEWEGG_SECRET_KEY`, `NEWEGG_MARKETPLACE`, `NEWEGG_CREDENTIALS_MARKETPLACE` (the marketplace the keys were issued for; must equal `NEWEGG_MARKETPLACE`; or use the `NEWEGG_<MP>_*` credential names).
Optional HTTP knobs: `NEWEGG_MCP_HTTP_HOST` (default `127.0.0.1`), `NEWEGG_MCP_HTTP_PORT`
(default `3919`), `NEWEGG_MCP_HTTP_BEARER_TOKEN`, `NEWEGG_MCP_HTTP_ALLOWED_ORIGINS`,
`NEWEGG_MCP_HTTP_ALLOWED_HOSTS`. Never commit real values — see
[`.env.example`](../../.env.example).

## Run

```bash
NEWEGG_SELLER_ID=... NEWEGG_API_KEY=... NEWEGG_SECRET_KEY=... NEWEGG_MARKETPLACE=us \
  NEWEGG_CREDENTIALS_MARKETPLACE=us \
  npm run start -w example-mcp-http

# in another terminal:
curl -s http://127.0.0.1:3919/healthz
```

## Writes

**Read-only by default.** With `NEWEGG_MCP_ALLOW_WRITES` unset (or not `true`), the mutating
`newegg_inventory_apply_update` tool is not registered. Setting `NEWEGG_MCP_ALLOW_WRITES=true`
registers it, and applying a preview through it **writes to a REAL Newegg account**.

## Typecheck

```bash
npm run typecheck -w example-mcp-http
```
