#!/usr/bin/env node
/**
 * Command-line entry point (the package `bin`). Chooses a transport (`--transport stdio|http`,
 * default stdio), loads configuration from the environment, wires graceful shutdown, and logs
 * exclusively to stderr — it never writes to stdout, which the stdio transport owns.
 *
 * `main` is guarded so importing this module (e.g. to unit-test `parseCliArgs`) has no side
 * effects.
 */
import { pathToFileURL } from "node:url";
import { loadMcpConfigFromEnv, type McpServerConfig } from "./config/index.js";
import { InMemoryPreviewStore } from "./preview-store/index.js";
import { createNeweggMcpServer, defaultLogger } from "./server/build.js";
import { connectStdioTransport } from "./server/stdio.js";
import { startHttpServer } from "./server/http.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import type { Logger } from "./tools/index.js";

export type TransportName = "stdio" | "http";

export interface CliArgs {
  readonly transport: TransportName;
  readonly help: boolean;
}

const USAGE = `newegg-marketplace-mcp — Newegg Marketplace MCP server

Usage:
  newegg-marketplace-mcp [--transport stdio|http]

Options:
  --transport <stdio|http>   Transport to serve (default: stdio)
  -h, --help                 Show this help

Configuration is read from environment variables (see .env.example). All logging goes to
stderr; the stdio transport uses stdout exclusively for protocol messages.`;

/** Parses argv (without node/script prefix). Throws on unknown args or a bad transport value. */
export function parseCliArgs(argv: string[]): CliArgs {
  let transport: TransportName = "stdio";
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--transport") {
      const value = argv[index + 1];
      index += 1;
      transport = parseTransportValue(value);
    } else if (arg.startsWith("--transport=")) {
      transport = parseTransportValue(arg.slice("--transport=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { transport, help };
}

function parseTransportValue(value: string | undefined): TransportName {
  if (value === "stdio" || value === "http") {
    return value;
  }
  throw new Error(
    `Invalid --transport value: ${value ?? "(missing)"} (expected "stdio" or "http").`,
  );
}

async function runStdio(config: McpServerConfig, logger: Logger): Promise<void> {
  const instance = createNeweggMcpServer({ config, logger });
  await connectStdioTransport(instance.server);
  logger("info", "server_started", {
    transport: "stdio",
    marketplace: config.marketplace,
    writesEnabled: config.allowWrites,
  });
  await waitForShutdown(() => instance.close(), logger);
}

async function runHttp(config: McpServerConfig, logger: Logger): Promise<void> {
  // A single preview store is shared across sessions; each session gets its own MCP server.
  const previewStore = new InMemoryPreviewStore();
  const handle = await startHttpServer({
    http: config.http,
    createServer: () => createNeweggMcpServer({ config, previewStore, logger }),
    logger,
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  });
  logger("info", "server_started", {
    transport: "http",
    host: config.http.host,
    port: handle.port,
    marketplace: config.marketplace,
    writesEnabled: config.allowWrites,
    authRequired: config.http.bearerToken !== undefined,
  });
  await waitForShutdown(() => handle.close(), logger);
}

function waitForShutdown(onShutdown: () => Promise<void>, logger: Logger): Promise<void> {
  return new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logger("info", "shutdown", { signal });
      onShutdown()
        .catch((error: unknown) => {
          logger("error", "shutdown_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => resolve());
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
}

/** Runs the server. Guarded from executing on import; safe to import for unit tests. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const logger = defaultLogger;

  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    logger("error", "cli_args_error", {
      message: error instanceof Error ? error.message : String(error),
    });
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    console.error(USAGE);
    return;
  }

  let config: McpServerConfig;
  try {
    config = loadMcpConfigFromEnv();
  } catch (error) {
    logger("error", "config_error", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  if (args.transport === "http") {
    await runHttp(config, logger);
  } else {
    await runStdio(config, logger);
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  void main();
}
