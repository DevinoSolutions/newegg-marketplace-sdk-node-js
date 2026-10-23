#!/usr/bin/env node
/**
 * Command-line entry point (the package `bin`). Chooses a transport (`--transport stdio|http`,
 * default stdio), loads configuration from the environment, wires graceful shutdown, and logs
 * exclusively to stderr — it never writes to stdout, which the stdio transport owns. The one
 * exception is `--generate-token`, which prints a fresh secret to stdout and exits before any
 * transport starts, and `--clear-label-guard`, the operator-only command that removes one order's
 * label-create guard record from the operation store file (T-6280); it needs no credentials.
 *
 * `main` is guarded so importing this module (e.g. to unit-test `parseCliArgs`) has no side
 * effects.
 */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadMcpConfigFromEnv,
  normalizeMarketplace,
  type McpServerConfig,
} from "./config/index.js";
import { generateSecretToken } from "./config/token-strength.js";
import { InMemoryPreviewStore } from "./preview-store/index.js";
import { releaseStoreLock } from "./server/file-operation-store.js";
import { assertOperationStoreFileUsable, clearLabelCreateGuard } from "./server/operation-store.js";
import { createNeweggMcpServer, defaultLogger } from "./server/build.js";
import { connectStdioTransport } from "./server/stdio.js";
import { startHttpServer, type HttpServerHandle } from "./server/http.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import type { Logger } from "./tools/index.js";

export type TransportName = "stdio" | "http";

export interface CliArgs {
  readonly transport: TransportName;
  readonly help: boolean;
  /** Print one fresh random secret to stdout and exit (no configuration needed). */
  readonly generateToken: boolean;
  /** Remove one order's label-create guard record from the operation store file, then exit. */
  readonly clearLabelGuard?: { readonly marketplace: string; readonly orderNumber: string };
  /** Remove the operation store lock file a crashed server left behind, then exit. */
  readonly releaseStoreLock?: { readonly force: boolean };
}

const USAGE = `newegg-marketplace-mcp — Newegg Marketplace MCP server

Usage:
  newegg-marketplace-mcp [--transport stdio|http]
  newegg-marketplace-mcp --generate-token
  newegg-marketplace-mcp --clear-label-guard <us|b2b|ca> <order number>
  newegg-marketplace-mcp --release-store-lock [--force]

Options:
  --transport <stdio|http>   Transport to serve (default: stdio)
  --generate-token           Print a fresh random secret (64 hex characters) to stdout and exit; use
                             it for NEWEGG_MCP_HTTP_BEARER_TOKEN or NEWEGG_MCP_PREVIEW_HMAC_KEY
  --clear-label-guard <marketplace> <order number>
                             Operator only: remove that order's label-create duplicate-purchase
                             record from NEWEGG_MCP_OPERATION_STORE_FILE and exit. Verify in the
                             Seller Portal that no label exists first, then restart the server. Not
                             available through any MCP tool.
  --release-store-lock [--force]
                             Operator only: remove the lock file a crashed server left beside
                             NEWEGG_MCP_OPERATION_STORE_FILE. Refuses unless the lock was taken on this
                             host by a process that is gone; --force overrides, only after you have
                             made sure no server or command is using the store, and run it with every
                             server of that store stopped, one run at a time. Not available through any
                             MCP tool.
  -h, --help                 Show this help

Configuration is read from environment variables (see .env.example). All logging goes to
stderr; the stdio transport uses stdout exclusively for protocol messages.`;

/** Parses argv (without node/script prefix). Throws on unknown args or a bad transport value. */
export function parseCliArgs(argv: string[]): CliArgs {
  let transport: TransportName = "stdio";
  let help = false;
  let generateToken = false;
  let clearLabelGuard: CliArgs["clearLabelGuard"];
  let release = false;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--generate-token") {
      generateToken = true;
    } else if (arg === "--clear-label-guard") {
      clearLabelGuard = parseClearLabelGuard(argv[index + 1], argv[index + 2]);
      index += 2;
    } else if (arg === "--release-store-lock") {
      release = true;
    } else if (arg === "--force") {
      force = true;
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

  if (force && !release) {
    throw new Error("--force only applies to --release-store-lock.");
  }
  return {
    transport,
    help,
    generateToken,
    clearLabelGuard,
    ...(release ? { releaseStoreLock: { force } } : {}),
  };
}

function parseClearLabelGuard(
  marketplaceArg: string | undefined,
  orderArg: string | undefined,
): NonNullable<CliArgs["clearLabelGuard"]> {
  const marketplace =
    marketplaceArg === undefined ? undefined : normalizeMarketplace(marketplaceArg);
  if (marketplace === undefined || orderArg === undefined || !/^[1-9]\d{0,9}$/.test(orderArg)) {
    throw new Error(
      "--clear-label-guard needs a marketplace (us, b2b or ca) and an order number, e.g. " +
        "--clear-label-guard ca 123456789.",
    );
  }
  return { marketplace, orderNumber: orderArg };
}

/** The operator commands' store path: NEWEGG_MCP_OPERATION_STORE_FILE, which must be absolute. */
function operatorStorePath(logger: Logger): string | undefined {
  const raw = process.env["NEWEGG_MCP_OPERATION_STORE_FILE"]?.trim() ?? "";
  if (raw === "") {
    logger("error", "config_error", {
      message: "NEWEGG_MCP_OPERATION_STORE_FILE is not set, so there is no persistent ledger.",
    });
  } else if (!isAbsolute(raw)) {
    logger("error", "config_error", {
      message: "NEWEGG_MCP_OPERATION_STORE_FILE must be an absolute path.",
    });
  } else {
    return raw;
  }
  process.exitCode = 1;
  return undefined;
}

/** Runs `--release-store-lock`: reads only NEWEGG_MCP_OPERATION_STORE_FILE, never credentials. */
async function runReleaseStoreLock(
  options: NonNullable<CliArgs["releaseStoreLock"]>,
  logger: Logger,
): Promise<void> {
  const path = operatorStorePath(logger);
  if (path === undefined) return;
  try {
    const result = await releaseStoreLock(path, { force: options.force });
    logger("info", result === "released" ? "store_lock_released" : "store_lock_absent", {
      ...(result === "released"
        ? { next: "Check the ledger is intact, then start the server." }
        : { message: "There is no lock file beside the operation store." }),
    });
  } catch (error) {
    logger("error", "operation_store_error", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

/** Runs `--clear-label-guard`: reads only NEWEGG_MCP_OPERATION_STORE_FILE, never credentials. */
async function runClearLabelGuard(
  target: NonNullable<CliArgs["clearLabelGuard"]>,
  logger: Logger,
): Promise<void> {
  const raw = operatorStorePath(logger);
  if (raw === undefined) return;
  try {
    const cleared = await clearLabelCreateGuard(raw, target.marketplace, target.orderNumber);
    logger(cleared ? "info" : "error", cleared ? "label_guard_cleared" : "label_guard_not_found", {
      marketplace: target.marketplace,
      orderNumber: target.orderNumber,
      ...(cleared
        ? { next: "A running server keeps blocking until it is restarted: restart it." }
        : { message: "The store file holds no guard record for that order." }),
    });
    if (!cleared) process.exitCode = 1;
  } catch (error) {
    logger("error", "operation_store_error", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
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
  // One preview store backs every session, but previews are bound to the MCP session that created
  // them (T-5675): each session gets its own MCP server stamped with its sessionId, and the store
  // only returns or consumes a record for the session that owns it.
  const previewStore = new InMemoryPreviewStore();
  let handle: HttpServerHandle;
  try {
    handle = await startHttpServer({
      http: config.http,
      // Writes need a bearer token even on loopback; startHttpServer refuses to start otherwise.
      writesEnabled: config.allowWrites,
      // Each HTTP session gets its own sessionId, so its previews cannot be applied from another one.
      createServer: (sessionId) =>
        createNeweggMcpServer({ config, previewStore, logger, sessionId }),
      logger,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  } catch (error) {
    // Startup refusals (no token with writes or a non-loopback bind, weak token) carry no secret
    // values, so the message is safe to log; exit non-zero instead of an unhandled rejection.
    logger("error", "http_start_refused", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }
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

  if (args.generateToken) {
    // The only stdout write in this file: no transport is running, and the caller captures it.
    process.stdout.write(`${generateSecretToken()}\n`);
    return;
  }

  if (args.releaseStoreLock !== undefined) {
    await runReleaseStoreLock(args.releaseStoreLock, logger);
    return;
  }

  if (args.clearLabelGuard !== undefined) {
    await runClearLabelGuard(args.clearLabelGuard, logger);
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

  if (config.operationStoreFile !== undefined) {
    // Fail at start, not at the first label: a corrupt ledger must never be replaced by an empty one.
    try {
      assertOperationStoreFileUsable(config.operationStoreFile);
    } catch (error) {
      logger("error", "operation_store_error", {
        message: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
      return;
    }
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
