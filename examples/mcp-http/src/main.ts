/**
 * Example — run the Newegg MCP server over Streamable HTTP using the package's own exports.
 *
 * Mirrors the HTTP path of the package `bin` (cli.ts): load configuration, then `startHttpServer`
 * with a per-session `createServer` factory that shares one preview store. The server listens on
 * `config.http.host:port` (default 127.0.0.1:3919), serves MCP at `POST /mcp`, and exposes an
 * unauthenticated `GET /healthz`. Binding a non-loopback host requires
 * `NEWEGG_MCP_HTTP_BEARER_TOKEN`; `Origin` and `Host` headers are validated on `/mcp`.
 *
 * READ-ONLY BY DEFAULT: `newegg_inventory_apply_update` is registered only when
 * NEWEGG_MCP_ALLOW_WRITES=true, and applying a preview through it writes to a REAL Newegg account.
 *
 * Run:
 *   NEWEGG_SELLER_ID=... NEWEGG_API_KEY=... NEWEGG_SECRET_KEY=... NEWEGG_MARKETPLACE=us \
 *     npm run start -w example-mcp-http
 *   # then, in another terminal:
 *   curl -s http://127.0.0.1:3919/healthz
 */
import {
  InMemoryPreviewStore,
  McpConfigError,
  SERVER_NAME,
  SERVER_VERSION,
  createNeweggMcpServer,
  defaultLogger,
  loadMcpConfigFromEnv,
  startHttpServer,
  type McpServerConfig,
} from "@devino/newegg-marketplace-mcp";

async function main(): Promise<void> {
  const logger = defaultLogger;

  let config: McpServerConfig;
  try {
    config = loadMcpConfigFromEnv();
  } catch (error) {
    if (error instanceof McpConfigError) {
      console.error(error.message);
      console.error("See .env.example for the required variables.");
      process.exit(1);
    }
    throw error;
  }

  // One preview store is shared across sessions; each session gets its own MCP server instance.
  const previewStore = new InMemoryPreviewStore();
  const handle = await startHttpServer({
    http: config.http,
    createServer: () => createNeweggMcpServer({ config, previewStore, logger }),
    logger,
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  });

  logger("info", "example_http_ready", {
    host: config.http.host,
    port: handle.port,
    marketplace: config.marketplace,
    writesEnabled: config.allowWrites,
    authRequired: config.http.bearerToken !== undefined,
  });
  console.error(`MCP endpoint: POST http://${config.http.host}:${handle.port}/mcp`);
  console.error(`Health check: GET  http://${config.http.host}:${handle.port}/healthz`);

  await waitForShutdown(() => handle.close());
}

/** Resolve on SIGINT/SIGTERM, closing the server exactly once. */
function waitForShutdown(onShutdown: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      void onShutdown().finally(() => {
        resolve();
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
