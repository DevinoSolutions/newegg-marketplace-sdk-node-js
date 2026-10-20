/**
 * The MCP-SDK-touching layer (ADR 0001). It adapts the pure tool definitions and resource
 * builders into MCP `registerTool` / `registerResource` calls, and exposes the public
 * `createNeweggMcpServer` factory. Tool *logic* lives under `../tools`; this file only wires it.
 */
import { type z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { createNeweggClient } from "@devino/newegg-marketplace-sdk";
import type {
  NeweggClient,
  NeweggClientConfig,
  NeweggLogger,
} from "@devino/newegg-marketplace-sdk";
import type { McpServerConfig } from "../config/index.js";
import { InMemoryPreviewStore, type PreviewStore } from "../preview-store/index.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";
import { buildCapabilities, buildPublicConfiguration } from "../resources/index.js";
import {
  TOOL_NAMES,
  catalogLookupStatusTool,
  catalogResolveTool,
  reportsDailyInventoryTool,
  reportsDailyPriceTool,
  reportsItemBasicInfoTool,
  reportsOrderListTool,
  reportsRmaListTool,
  reportsSettlementSummaryTool,
  reportsSettlementTransactionsTool,
  reportsStatusTool,
  createInventoryPreviewTool,
  createListingPreviewTool,
  listingApplyTool,
  volumeDiscountGetTool,
  createVolumeDiscountPreviewTool,
  volumeDiscountApplyTool,
  feedResultTool,
  feedStatusInputSchema,
  feedStatusTool,
  inventoryApplyTool,
  inventoryGetTool,
  ordersGetStatusTool,
  ordersGetAdditionalInfoTool,
  ordersGetTool,
  ordersListTool,
  refundListTool,
  refundStatusTool,
  rmaGetTool,
  rmaListTool,
  createRmaPreviewSubmitTool,
  rmaApplySubmitTool,
  createRmaPreviewEditTool,
  rmaApplyEditTool,
  createRmaPreviewProcessTool,
  rmaApplyProcessTool,
  createRmaPreviewRejectTool,
  rmaApplyRejectTool,
  createRefundPreviewIssueTool,
  refundApplyIssueTool,
  createPricingPreviewTool,
  pricingApplyTool,
  pricingGetTool,
  serviceStatusTool,
  sellerStatusTool,
  industriesListTool,
  subcategoriesListTool,
  subcategoryPropertiesTool,
  propertyValuesTool,
  sbnShipmentsListTool,
  sbnRequestStatusTool,
  sbnRequestResultTool,
  sbnWarehousesListTool,
  shippingLabelEstimateTool,
  shippingLabelPreviewCreateTool,
  shippingLabelApplyCreateTool,
  shippingLabelPreviewReprintTool,
  shippingLabelApplyReprintTool,
  type Logger,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "../tools/index.js";

/** Default structured logger: JSON lines on stderr (never stdout). */
export const defaultLogger: Logger = (level, event, fields) => {
  const entry: Record<string, unknown> = { level, event, time: new Date().toISOString() };
  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        entry[key] = value;
      }
    }
  }
  console.error(JSON.stringify(entry));
};

/** Options for the server factory. Injecting `client`/`previewStore` is how tests wire mocks. */
export interface CreateNeweggMcpServerOptions {
  readonly config: McpServerConfig;
  readonly client?: NeweggClient;
  readonly previewStore?: PreviewStore;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export interface NeweggMcpServer {
  readonly server: McpServer;
  close(): Promise<void>;
}

/** Fully-resolved dependencies for {@link buildMcpServer}. */
export interface ServerDeps {
  readonly config: McpServerConfig;
  readonly client: NeweggClient;
  readonly previewStore: PreviewStore;
  readonly logger: Logger;
  readonly now: () => Date;
}

function adaptLogger(logger: Logger): NeweggLogger {
  return {
    debug: (event, fields) => logger("debug", event, fields),
    info: (event, fields) => logger("info", event, fields),
    warn: (event, fields) => logger("warn", event, fields),
    error: (event, fields) => logger("error", event, fields),
  };
}

/** Builds the SDK client from config. Only the trusted base-URL override is forwarded. */
function createClientFromConfig(config: McpServerConfig, logger: Logger): NeweggClient {
  const clientConfig: NeweggClientConfig = {
    sellerId: config.credentials.sellerId,
    apiKey: config.credentials.apiKey,
    secretKey: config.credentials.secretKey,
    marketplace: config.marketplace,
    logger: adaptLogger(logger),
  };
  if (config.baseUrl !== undefined) {
    clientConfig.baseUrl = config.baseUrl;
  }
  return createNeweggClient(clientConfig);
}

/** The set of tool names actually registered for a given config (apply present only with writes). */
export function enabledToolNames(config: McpServerConfig): string[] {
  const names: string[] = [TOOL_NAMES.inventoryGet, TOOL_NAMES.inventoryPreviewUpdate];
  if (config.allowWrites) {
    names.push(TOOL_NAMES.inventoryApplyUpdate);
  }
  // Price reads (Get Item Price) are read-only and never write-gated.
  names.push(TOOL_NAMES.pricingGet);
  names.push(TOOL_NAMES.feedStatus, TOOL_NAMES.feedResult, TOOL_NAMES.serviceStatus);
  // Order reads are always available (never write-gated).
  names.push(
    TOOL_NAMES.ordersList,
    TOOL_NAMES.ordersGet,
    TOOL_NAMES.ordersGetStatus,
    TOOL_NAMES.ordersGetAdditionalInfo,
  );
  // RMA / courtesy refund reads (contracts §18) are always available (never write-gated).
  names.push(TOOL_NAMES.rmaList, TOOL_NAMES.rmaGet, TOOL_NAMES.refundList, TOOL_NAMES.refundStatus);
  // Seller / category reference reads (contracts §19) are always available (never write-gated).
  names.push(
    TOOL_NAMES.sellerStatus,
    TOOL_NAMES.industriesList,
    TOOL_NAMES.subcategoriesList,
    TOOL_NAMES.subcategoryProperties,
    TOOL_NAMES.propertyValues,
  );
  // Shipped-by-Newegg inbound-shipment reads (contracts §21) are always available (never write-gated).
  names.push(
    TOOL_NAMES.sbnShipmentsList,
    TOOL_NAMES.sbnRequestStatus,
    TOOL_NAMES.sbnRequestResult,
    TOOL_NAMES.sbnWarehousesList,
  );
  // The Shipping Label quote (contracts §23) is documented as estimation only: always available.
  names.push(TOOL_NAMES.shippingLabelEstimate);
  // Catalog resolution is read-only (report submission mutates nothing; contracts §12.4).
  names.push(TOOL_NAMES.catalogResolve, TOOL_NAMES.catalogLookupStatus);
  // Reports (settlement / daily inventory / daily price) are read-only report jobs (contracts §17).
  names.push(
    TOOL_NAMES.reportsSettlementSummary,
    TOOL_NAMES.reportsSettlementTransactions,
    TOOL_NAMES.reportsDailyInventory,
    TOOL_NAMES.reportsDailyPrice,
    TOOL_NAMES.reportsItemBasicInfo,
    TOOL_NAMES.reportsOrderList,
    TOOL_NAMES.reportsRmaList,
    TOOL_NAMES.reportsStatus,
  );
  // Listing creation: preview is read-only; apply is write-gated.
  names.push(TOOL_NAMES.listingPreviewCreate);
  if (config.allowWrites) {
    names.push(TOOL_NAMES.listingApplyCreate);
  }
  // Volume discounts (contracts §22): the read and the offline preview are never write-gated;
  // apply is write-gated.
  names.push(TOOL_NAMES.volumeDiscountGet, TOOL_NAMES.volumeDiscountPreviewUpdate);
  if (config.allowWrites) {
    names.push(TOOL_NAMES.volumeDiscountApplyUpdate);
  }
  // Price updates: BOTH the preview and the apply tool exist only with writes enabled.
  if (config.allowWrites) {
    names.push(TOOL_NAMES.pricingPreviewUpdate, TOOL_NAMES.pricingApplyUpdate);
  }
  // RMA and courtesy-refund writes (contracts §20) move customer money or change a return: BOTH the
  // preview and the apply tool of each exist only with writes enabled.
  if (config.allowWrites) {
    names.push(
      TOOL_NAMES.rmaPreviewSubmit,
      TOOL_NAMES.rmaApplySubmit,
      TOOL_NAMES.rmaPreviewEdit,
      TOOL_NAMES.rmaApplyEdit,
      TOOL_NAMES.rmaPreviewProcess,
      TOOL_NAMES.rmaApplyProcess,
      TOOL_NAMES.rmaPreviewReject,
      TOOL_NAMES.rmaApplyReject,
      TOOL_NAMES.refundPreviewIssue,
      TOOL_NAMES.refundApplyIssue,
    );
  }
  // Buying or reprinting a UPS label spends money (contracts §23): BOTH the preview and the apply
  // tool of each exist only with writes enabled.
  if (config.allowWrites) {
    names.push(
      TOOL_NAMES.shippingLabelPreviewCreate,
      TOOL_NAMES.shippingLabelApplyCreate,
      TOOL_NAMES.shippingLabelPreviewReprint,
      TOOL_NAMES.shippingLabelApplyReprint,
    );
  }
  return names;
}

function toCallToolResult(result: ToolResult): CallToolResult {
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(result.error, null, 2) }],
    };
  }
  // Round-trip through JSON so the structured object is pure JSON (no undefined/Date) and is
  // byte-identical to its text fallback.
  const structured = JSON.parse(JSON.stringify(result.structuredContent)) as Record<
    string,
    unknown
  >;
  return {
    structuredContent: structured,
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
  };
}

function registerToolDefinition<InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  server: McpServer,
  definition: ToolDefinition<InputSchema, OutputSchema>,
  ctx: ToolContext,
): void {
  // The schemas are widened to the concrete `z.ZodType` so the SDK's overload resolves the tool
  // callback's arg type (a conditional over a bare type variable would stay deferred). The real
  // (strict) schema object is still used at runtime for validation and JSON-schema generation.
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema as z.ZodType,
      outputSchema: definition.outputSchema as z.ZodType,
      annotations: definition.annotations,
    },
    async (args) =>
      // The MCP SDK has already validated `args` against the input schema; this cast bridges the
      // SDK's inferred arg type to the handler's zod-inferred input type.
      toCallToolResult(await definition.handler(args as unknown as z.infer<InputSchema>, ctx)),
  );
}

function jsonResource(uri: URL, payload: unknown): ReadResourceResult {
  return {
    contents: [
      { uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function registerResources(server: McpServer, ctx: ToolContext, toolNames: string[]): void {
  server.registerResource(
    "newegg-capabilities",
    "newegg://capabilities",
    {
      title: "Newegg MCP server capabilities",
      description: "Server identity, registered tools, marketplace, and configured limits.",
      mimeType: "application/json",
    },
    (uri) => jsonResource(uri, buildCapabilities(ctx.config, toolNames)),
  );

  server.registerResource(
    "newegg-configuration-public",
    "newegg://configuration/public",
    {
      title: "Newegg MCP public configuration",
      description: "Non-sensitive operational configuration and Newegg batch limits.",
      mimeType: "application/json",
    },
    (uri) => jsonResource(uri, buildPublicConfiguration(ctx.config, toolNames)),
  );

  server.registerResource(
    "newegg-feed",
    new ResourceTemplate("newegg://feeds/{requestId}", { list: undefined }),
    {
      title: "Newegg feed status",
      description:
        "Feed processing status for a given feed request id (same payload as newegg_feed_status).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = variables.requestId;
      const requestId = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
      const parsed = feedStatusInputSchema.safeParse({ requestId });
      if (!parsed.success) {
        return jsonResource(uri, {
          errorCode: "validation",
          message:
            "Invalid feed requestId in resource URI (expected 1-64 alphanumeric characters).",
        });
      }
      const result = await feedStatusTool.handler(parsed.data, ctx);
      return jsonResource(uri, result.ok ? result.structuredContent : result.error);
    },
  );
}

/** Builds and wires a fresh `McpServer` (not yet connected to a transport). */
export function buildMcpServer(deps: ServerDeps): McpServer {
  const { config } = deps;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const ctx: ToolContext = {
    client: deps.client,
    config,
    previewStore: deps.previewStore,
    logger: deps.logger,
    now: deps.now,
  };

  registerToolDefinition(server, inventoryGetTool, ctx);
  registerToolDefinition(server, createInventoryPreviewTool(config), ctx);
  if (config.allowWrites) {
    registerToolDefinition(server, inventoryApplyTool, ctx);
  }
  registerToolDefinition(server, pricingGetTool, ctx);
  registerToolDefinition(server, feedStatusTool, ctx);
  registerToolDefinition(server, feedResultTool, ctx);
  registerToolDefinition(server, serviceStatusTool, ctx);
  registerToolDefinition(server, ordersListTool, ctx);
  registerToolDefinition(server, ordersGetTool, ctx);
  registerToolDefinition(server, ordersGetStatusTool, ctx);
  registerToolDefinition(server, ordersGetAdditionalInfoTool, ctx);
  registerToolDefinition(server, rmaListTool, ctx);
  registerToolDefinition(server, rmaGetTool, ctx);
  registerToolDefinition(server, refundListTool, ctx);
  registerToolDefinition(server, refundStatusTool, ctx);
  registerToolDefinition(server, sellerStatusTool, ctx);
  registerToolDefinition(server, industriesListTool, ctx);
  registerToolDefinition(server, subcategoriesListTool, ctx);
  registerToolDefinition(server, subcategoryPropertiesTool, ctx);
  registerToolDefinition(server, propertyValuesTool, ctx);
  registerToolDefinition(server, sbnShipmentsListTool, ctx);
  registerToolDefinition(server, sbnRequestStatusTool, ctx);
  registerToolDefinition(server, sbnRequestResultTool, ctx);
  registerToolDefinition(server, sbnWarehousesListTool, ctx);
  registerToolDefinition(server, shippingLabelEstimateTool, ctx);
  registerToolDefinition(server, catalogResolveTool, ctx);
  registerToolDefinition(server, catalogLookupStatusTool, ctx);
  registerToolDefinition(server, reportsSettlementSummaryTool, ctx);
  registerToolDefinition(server, reportsSettlementTransactionsTool, ctx);
  registerToolDefinition(server, reportsDailyInventoryTool, ctx);
  registerToolDefinition(server, reportsDailyPriceTool, ctx);
  registerToolDefinition(server, reportsItemBasicInfoTool, ctx);
  registerToolDefinition(server, reportsOrderListTool, ctx);
  registerToolDefinition(server, reportsRmaListTool, ctx);
  registerToolDefinition(server, reportsStatusTool, ctx);
  registerToolDefinition(server, createListingPreviewTool(config), ctx);
  if (config.allowWrites) {
    registerToolDefinition(server, listingApplyTool, ctx);
  }
  registerToolDefinition(server, volumeDiscountGetTool, ctx);
  registerToolDefinition(server, createVolumeDiscountPreviewTool(config), ctx);
  if (config.allowWrites) {
    registerToolDefinition(server, volumeDiscountApplyTool, ctx);
  }
  if (config.allowWrites) {
    registerToolDefinition(server, createPricingPreviewTool(config), ctx);
    registerToolDefinition(server, pricingApplyTool, ctx);
  }
  if (config.allowWrites) {
    registerToolDefinition(server, createRmaPreviewSubmitTool(config), ctx);
    registerToolDefinition(server, rmaApplySubmitTool, ctx);
    registerToolDefinition(server, createRmaPreviewEditTool(config), ctx);
    registerToolDefinition(server, rmaApplyEditTool, ctx);
    registerToolDefinition(server, createRmaPreviewProcessTool(config), ctx);
    registerToolDefinition(server, rmaApplyProcessTool, ctx);
    registerToolDefinition(server, createRmaPreviewRejectTool(config), ctx);
    registerToolDefinition(server, rmaApplyRejectTool, ctx);
    registerToolDefinition(server, createRefundPreviewIssueTool(config), ctx);
    registerToolDefinition(server, refundApplyIssueTool, ctx);
  }
  if (config.allowWrites) {
    registerToolDefinition(server, shippingLabelPreviewCreateTool, ctx);
    registerToolDefinition(server, shippingLabelApplyCreateTool, ctx);
    registerToolDefinition(server, shippingLabelPreviewReprintTool, ctx);
    registerToolDefinition(server, shippingLabelApplyReprintTool, ctx);
  }

  registerResources(server, ctx, enabledToolNames(config));
  return server;
}

/**
 * Creates a Newegg MCP server instance. When `client` is omitted, one is built from `config`
 * (only the trusted base-URL override is forwarded). The returned server is not yet connected
 * to a transport — callers connect it via stdio or the HTTP transport.
 */
export function createNeweggMcpServer(options: CreateNeweggMcpServerOptions): NeweggMcpServer {
  const { config } = options;
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => new Date());
  const client = options.client ?? createClientFromConfig(config, logger);
  const previewStore = options.previewStore ?? new InMemoryPreviewStore(now);
  const server = buildMcpServer({ config, client, previewStore, logger, now });
  return {
    server,
    close: () => server.close(),
  };
}
