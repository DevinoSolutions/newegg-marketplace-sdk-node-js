/**
 * Public entry point for `@devino/newegg-marketplace-mcp`.
 *
 * Embedders typically call `loadMcpConfigFromEnv()` then `createNeweggMcpServer({ config })`
 * and connect the returned server to a transport. Tests inject a `client` (wired to the SDK's
 * mock fetch) and/or a `previewStore`.
 */
export {
  createNeweggMcpServer,
  buildMcpServer,
  enabledToolNames,
  defaultLogger,
  type CreateNeweggMcpServerOptions,
  type NeweggMcpServer,
  type ServerDeps,
} from "./server/build.js";
export { connectStdioTransport } from "./server/stdio.js";
export {
  startHttpServer,
  type StartHttpServerOptions,
  type HttpServerHandle,
} from "./server/http.js";

export {
  loadMcpConfigFromEnv,
  McpConfigError,
  type EnvRecord,
  type McpCredentials,
  type McpHttpConfig,
  type McpLimits,
  type McpServerConfig,
} from "./config/index.js";

export {
  InMemoryPreviewStore,
  type ConsumeResult,
  type InventoryPreviewRecord,
  type ListingPreviewRecord,
  type PreviewRecord,
  type PreviewStore,
} from "./preview-store/index.js";

export { TOOL_NAMES, type ToolName } from "./tools/names.js";
export type { Logger, LogLevel } from "./tools/shared.js";

export { SERVER_NAME, SERVER_VERSION } from "./version.js";
