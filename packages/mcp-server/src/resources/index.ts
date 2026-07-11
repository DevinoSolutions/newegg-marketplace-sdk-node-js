/**
 * Pure builders for MCP resource payloads. Registration (touching the MCP SDK) lives in
 * `server/`. These functions return plain JSON-safe objects and never include credentials,
 * bearer tokens, or the base-URL override.
 */
import {
  GET_BATCH_INVENTORY_MAX_VALUES,
  INVENTORY_FEED_MAX_RECORDS,
  SDK_VERSION,
} from "@devino/newegg-marketplace-sdk";
import type { McpServerConfig } from "../config/index.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

/** Newegg feed throttling facts (documented, not secret) surfaced in the public config. */
const FEED_SUBMISSIONS_PER_MINUTE = 10;
const FEED_RECORDS_PER_HOUR = 100_000;

/**
 * `newegg://capabilities` — what this server exposes and how it is limited. `enabledToolNames`
 * is the set actually registered (the apply tool is absent when writes are disabled).
 */
export function buildCapabilities(
  config: McpServerConfig,
  enabledToolNames: string[],
): Record<string, unknown> {
  return {
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    sdkVersion: SDK_VERSION,
    mcpTools: enabledToolNames,
    writesEnabled: config.allowWrites,
    marketplace: config.marketplace,
    limits: {
      maxItemsPerOperation: config.limits.maxItemsPerOperation,
      previewTtlSeconds: config.limits.previewTtlSeconds,
      allowZeroQuantity: config.limits.allowZeroQuantity,
      allowedWarehouses: config.limits.allowedWarehouses,
      allowedMarketplaces: config.limits.allowedMarketplaces,
    },
  };
}

/**
 * `newegg://configuration/public` — non-sensitive operational configuration. Never includes
 * the api key, secret key, seller id, bearer token, or base-URL override.
 */
export function buildPublicConfiguration(
  config: McpServerConfig,
  enabledToolNames: string[],
): Record<string, unknown> {
  return {
    marketplace: config.marketplace,
    writesEnabled: config.allowWrites,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    sdkVersion: SDK_VERSION,
    enabledTools: enabledToolNames,
    allowedWarehouses: config.limits.allowedWarehouses,
    limits: {
      maxItemsPerOperation: config.limits.maxItemsPerOperation,
      previewTtlSeconds: config.limits.previewTtlSeconds,
      allowZeroQuantity: config.limits.allowZeroQuantity,
    },
    batchLimits: {
      feedMaxRecords: INVENTORY_FEED_MAX_RECORDS,
      feedSubmissionsPerMinute: FEED_SUBMISSIONS_PER_MINUTE,
      feedRecordsPerHour: FEED_RECORDS_PER_HOUR,
      batchReadChunkSize: GET_BATCH_INVENTORY_MAX_VALUES,
    },
  };
}
