# example-mcp-stdio

Run the Newegg MCP server over **stdio** using the package's own exported API. This mirrors
what the package `bin` (`newegg-marketplace-mcp`) does internally, so you can embed the server
in your own process instead of shelling out to the CLI.

## What it shows

- `loadMcpConfigFromEnv()` → `createNeweggMcpServer({ config, logger })` →
  `connectStdioTransport(instance.server)`, plus graceful shutdown on SIGINT/SIGTERM.
- `enabledToolNames(config)` to see exactly which tools are registered for the current config.
- stdio discipline: JSON-RPC on stdout, all logging on stderr (via `defaultLogger`).

An MCP client (e.g. Claude Desktop) normally launches this file as a subprocess. The client
config points `command`/`args` at it and provides the `NEWEGG_*` env; see the repository
[README](../../README.md#mcp-server--stdio).

## Environment

Required: `NEWEGG_SELLER_ID`, `NEWEGG_API_KEY`, `NEWEGG_SECRET_KEY`, `NEWEGG_MARKETPLACE`.
Config is read by `loadMcpConfigFromEnv()`, which throws `McpConfigError` (secret-free
message) if anything is missing. Never commit real values — see
[`.env.example`](../../.env.example).

## Run

```bash
NEWEGG_SELLER_ID=... NEWEGG_API_KEY=... NEWEGG_SECRET_KEY=... NEWEGG_MARKETPLACE=us \
  npm run start -w example-mcp-stdio
```

## Writes

**Read-only by default.** With `NEWEGG_MCP_ALLOW_WRITES` unset (or not `true`), the mutating
`newegg_inventory_apply_update` tool is not registered. Setting `NEWEGG_MCP_ALLOW_WRITES=true`
registers it, and applying a preview through it **writes to a REAL Newegg account**.

## Typecheck

```bash
npm run typecheck -w example-mcp-stdio
```
