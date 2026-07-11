/**
 * Example — run the Newegg MCP server over stdio using the package's own exports.
 *
 * Mirrors what the package `bin` (cli.ts) does: load configuration from the environment, build
 * the server with `createNeweggMcpServer`, and connect it to a stdio transport. An MCP client
 * (Claude Desktop, etc.) launches this as a subprocess and speaks JSON-RPC over stdout; all
 * logging goes to stderr.
 *
 * READ-ONLY BY DEFAULT: with NEWEGG_MCP_ALLOW_WRITES unset (or not "true"), the mutating
 * `newegg_inventory_apply_update` tool is NOT registered. Setting NEWEGG_MCP_ALLOW_WRITES=true
 * registers it, and applying a preview through it writes to a REAL Newegg account.
 *
 * Run (read-only):
 *   NEWEGG_SELLER_ID=... NEWEGG_API_KEY=... NEWEGG_SECRET_KEY=... NEWEGG_MARKETPLACE=us \
 *     npm run start -w example-mcp-stdio
 */
import {
  McpConfigError,
  connectStdioTransport,
  createNeweggMcpServer,
  defaultLogger,
  enabledToolNames,
  loadMcpConfigFromEnv,
  type McpServerConfig,
} from "@devino/newegg-marketplace-mcp";

async function main(): Promise<void> {
  const logger = defaultLogger;

  let config: McpServerConfig;
  try {
    // Reads NEWEGG_* from the environment. On any problem this throws McpConfigError with an
    // actionable, secret-free message (it names the offending variable, never its value).
    config = loadMcpConfigFromEnv();
  } catch (error) {
    if (error instanceof McpConfigError) {
      console.error(error.message);
      console.error("See .env.example for the required variables.");
      process.exit(1);
    }
    throw error;
  }

  const instance = createNeweggMcpServer({ config, logger });
  await connectStdioTransport(instance.server);

  // The apply (write) tool is present only when NEWEGG_MCP_ALLOW_WRITES=true.
  logger("info", "example_stdio_ready", {
    marketplace: config.marketplace,
    writesEnabled: config.allowWrites,
    tools: enabledToolNames(config),
  });

  await waitForShutdown(() => instance.close());
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
