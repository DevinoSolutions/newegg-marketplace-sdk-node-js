/**
 * Read-only Shipped-by-Newegg (SBN) inbound-shipment tools: `newegg_sbn_shipments_list`,
 * `newegg_sbn_request_status`, `newegg_sbn_request_result` and `newegg_sbn_warehouses_list`. They
 * consume only the SDK's public `SbnApi` (contracts §21) and register unconditionally (never
 * write-gated): every one is a READ, even where Newegg uses `PUT`. Creating and voiding inbound
 * shipments is not exposed. Newegg.com and Newegg Business only; on Canada each tool returns the
 * SDK's `unsupported_operation` error.
 *
 * Fields are mapped explicitly (SDK `raw` payloads are never requested). The request-result tool
 * returns label types, hosts and file names only: the label download URLs are never surfaced.
 */
import { z } from "zod";
import type {
  GetSbnRequestStatusInput,
  ListSbnShipmentsInput,
} from "@devino/newegg-marketplace-sdk";
import {
  errorResult,
  mapErrorToPayload,
  marketplaceSchema,
  okResult,
  rateLimitOutputSchema,
  serializeRateLimit,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./shared.js";
import { TOOL_NAMES } from "./names.js";

// ---------------------------------------------------------------------------
// shared schemas + helpers
// ---------------------------------------------------------------------------
const timestampSchema = z.object({ raw: z.string(), iso: z.string().optional() });

/** ISO 8601 (or `YYYY-MM-DD[ HH:mm:ss]`) -> Date so the SDK renders Pacific; otherwise pass through. */
function toDateInput(value: string | undefined): Date | string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date;
}

const dateInputSchema = (what: string) =>
  z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(`${what} (ISO 8601 e.g. 2026-09-01T00:00:00Z, Pacific-converted; or YYYY-MM-DD).`);

const requestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{1,64}$/, "a Newegg SBN request id: 1-64 letters or digits");

const addressSchema = z.object({
  address1: z.string().optional(),
  address2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  country: z.string().optional(),
});

/** Free-text detail from Newegg; bounded so it cannot flood tool output. */
function clip(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// ---------------------------------------------------------------------------
// newegg_sbn_shipments_list
// ---------------------------------------------------------------------------
const shipmentsInputSchema = z
  .strictObject({
    page: z.number().int().min(1).optional().describe("1-based page index (default 1)."),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Page size, max 100 (default 100). The response has no total: a full page may have more.",
      ),
    keywordType: z
      .enum(["all", "shipmentId", "neweggItemNumber", "sellerPartNumber"])
      .optional()
      .describe("What `keyword` matches (default all)."),
    keyword: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Shipment id, Newegg item number or seller part number, per keywordType."),
    status: z
      .enum([
        "all",
        "preparing",
        "shipped",
        "received",
        "partiallyReceived",
        "manuallyClosed",
        "voided",
      ])
      .optional()
      .describe("Shipment status filter (default all)."),
    updatedFrom: dateInputSchema("Lower bound on the shipment's last update"),
    updatedTo: dateInputSchema("Upper bound on the shipment's last update"),
  })
  .describe("Inbound shipment list criteria; all fields optional (default: last 30 days).");

const shipmentsOutputSchema = z.object({
  marketplace: marketplaceSchema,
  page: z.number(),
  pageSize: z.number(),
  shipments: z.array(
    z.object({
      shipmentId: z.string(),
      status: z.string().optional(),
      createdAt: timestampSchema.optional(),
      lastEditedAt: timestampSchema.optional(),
      shipFrom: z.string().optional(),
      shipToWarehouseCode: z.string().optional(),
      shipTo: addressSchema,
      shippingMethod: z.enum(["smallParcel", "lessThanTruckload"]).optional(),
      carrierCode: z.number().optional(),
      carrier: z.string().optional(),
      packages: z.array(
        z.object({
          trackingNumber: z.string().optional(),
          weight: z.number().optional(),
          length: z.number().optional(),
          height: z.number().optional(),
          width: z.number().optional(),
        }),
      ),
      items: z.array(
        z.object({
          sellerPartNumber: z.string().optional(),
          quantity: z.number().optional(),
          numberOfPackages: z.number().optional(),
        }),
      ),
    }),
  ),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function shipmentsHandler(
  input: z.infer<typeof shipmentsInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const listInput: ListSbnShipmentsInput = {};
  if (input.page !== undefined) listInput.page = input.page;
  if (input.pageSize !== undefined) listInput.pageSize = input.pageSize;
  if (input.keywordType !== undefined) listInput.keywordType = input.keywordType;
  if (input.keyword !== undefined) listInput.keyword = input.keyword;
  if (input.status !== undefined) listInput.status = input.status;
  const updatedFrom = toDateInput(input.updatedFrom);
  if (updatedFrom !== undefined) listInput.updatedFrom = updatedFrom;
  const updatedTo = toDateInput(input.updatedTo);
  if (updatedTo !== undefined) listInput.updatedTo = updatedTo;
  try {
    const result = await ctx.client.sbn.listShipments(listInput);
    return okResult({
      marketplace: result.marketplace,
      page: result.page,
      pageSize: result.pageSize,
      shipments: result.shipments.map((shipment) => ({
        shipmentId: shipment.shipmentId,
        status: shipment.status,
        createdAt: shipment.createdAt,
        lastEditedAt: shipment.lastEditedAt,
        shipFrom: shipment.shipFrom,
        shipToWarehouseCode: shipment.shipToWarehouseCode,
        shipTo: shipment.shipTo,
        shippingMethod: shipment.shippingMethod,
        carrierCode: shipment.carrierCode,
        carrier: shipment.carrier,
        packages: shipment.packages,
        items: shipment.items,
      })),
      correlationId: result.correlationId,
      rateLimit: serializeRateLimit(result.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const sbnShipmentsListTool: ToolDefinition<
  typeof shipmentsInputSchema,
  typeof shipmentsOutputSchema
> = {
  name: TOOL_NAMES.sbnShipmentsList,
  title: "List Shipped-by-Newegg inbound shipments",
  description:
    "Get Inbound Shipment List: the seller's Shipped-by-Newegg (SBN) inbound shipments to Newegg " +
    "warehouses (shipment id, status, destination warehouse, carrier, packages and item " +
    "quantities), by shipment id / Newegg item number / seller part number, status or last-update " +
    "range (default: the last 30 days). Newegg.com and Newegg Business only. Newegg allows 500 " +
    "requests/hour. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: shipmentsInputSchema,
  outputSchema: shipmentsOutputSchema,
  handler: shipmentsHandler,
};

// ---------------------------------------------------------------------------
// newegg_sbn_request_status
// ---------------------------------------------------------------------------
const requestStatusInputSchema = z
  .strictObject({
    requestIds: z
      .array(requestIdSchema)
      .min(1)
      .max(100)
      .optional()
      .describe("Submission request ids; when set, Newegg ignores every other filter."),
    action: z
      .enum(["all", "create", "void"])
      .optional()
      .describe("Create or void submissions only (default all)."),
    maxCount: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum records (default 100)."),
    requestStatus: z
      .enum(["ALL", "SUBMITTED", "IN_PROGRESS", "FINISHED", "CANCELLED"])
      .optional()
      .describe("Submission status filter (default ALL)."),
    requestDateFrom: dateInputSchema("Lower bound on the submission date"),
    requestDateTo: dateInputSchema("Upper bound on the submission date"),
  })
  .describe("Inbound shipment submission status criteria; all fields optional.");

const requestStatusOutputSchema = z.object({
  marketplace: marketplaceSchema,
  requests: z.array(
    z.object({
      requestId: z.string(),
      action: z.enum(["create", "void"]).optional(),
      requestedAt: timestampSchema.optional(),
      status: z.string().optional(),
      memo: z.string().optional(),
    }),
  ),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function requestStatusHandler(
  input: z.infer<typeof requestStatusInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const statusInput: GetSbnRequestStatusInput = {};
  if (input.requestIds !== undefined) statusInput.requestIds = input.requestIds;
  if (input.action !== undefined) statusInput.action = input.action;
  if (input.maxCount !== undefined) statusInput.maxCount = input.maxCount;
  if (input.requestStatus !== undefined) statusInput.requestStatus = input.requestStatus;
  const from = toDateInput(input.requestDateFrom);
  if (from !== undefined) statusInput.requestDateFrom = from;
  const to = toDateInput(input.requestDateTo);
  if (to !== undefined) statusInput.requestDateTo = to;
  try {
    const result = await ctx.client.sbn.getRequestStatus(statusInput);
    return okResult({
      marketplace: result.marketplace,
      requests: result.requests.map((request) => ({
        requestId: request.requestId,
        action: request.action,
        requestedAt: request.requestedAt,
        status: request.status,
        memo: request.memo === undefined ? undefined : clip(request.memo),
      })),
      correlationId: result.correlationId,
      rateLimit: serializeRateLimit(result.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const sbnRequestStatusTool: ToolDefinition<
  typeof requestStatusInputSchema,
  typeof requestStatusOutputSchema
> = {
  name: TOOL_NAMES.sbnRequestStatus,
  title: "Get Shipped-by-Newegg shipment request status",
  description:
    "Get Inbound Shipment Status Request: whether create / void inbound-shipment submissions are " +
    "SUBMITTED, IN_PROGRESS, FINISHED or CANCELLED, filterable by request id, action, status and " +
    "submission date. Newegg.com and Newegg Business only. Newegg allows 1,000 requests/minute. " +
    "Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: requestStatusInputSchema,
  outputSchema: requestStatusOutputSchema,
  handler: requestStatusHandler,
};

// ---------------------------------------------------------------------------
// newegg_sbn_request_result
// ---------------------------------------------------------------------------
const requestResultInputSchema = z
  .strictObject({ requestId: requestIdSchema })
  .describe("The inbound shipment submission whose result to read.");

const requestResultOutputSchema = z.object({
  marketplace: marketplaceSchema,
  requestId: z.string(),
  requestedAt: timestampSchema.optional(),
  processedAt: timestampSchema.optional(),
  status: z.string().optional(),
  shipmentId: z.string().optional(),
  labels: z.array(
    z.object({
      type: z.string().optional(),
      host: z.string().optional(),
      fileName: z.string().optional(),
    }),
  ),
  errors: z.array(z.string()),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function requestResultHandler(
  input: z.infer<typeof requestResultInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await ctx.client.sbn.getRequestResult(input.requestId);
    return okResult({
      marketplace: result.marketplace,
      requestId: result.requestId,
      requestedAt: result.requestedAt,
      processedAt: result.processedAt,
      status: result.status,
      shipmentId: result.shipmentId,
      labels: result.labels.map((label) => ({
        type: label.type,
        host: label.host,
        fileName: label.fileName,
      })),
      errors: result.errors.map((message) => clip(message)),
      correlationId: result.correlationId,
      rateLimit: serializeRateLimit(result.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const sbnRequestResultTool: ToolDefinition<
  typeof requestResultInputSchema,
  typeof requestResultOutputSchema
> = {
  name: TOOL_NAMES.sbnRequestResult,
  title: "Get Shipped-by-Newegg shipment request result",
  description:
    "Get Inbound Shipment Request Result: the processing outcome of one inbound-shipment " +
    "submission (status, resulting shipment id, any error text) and the labels Newegg generated " +
    "(type, host and file name only: the download URLs are credential-bearing and never " +
    "returned). Newegg.com and Newegg Business only. Newegg allows 500 requests/hour. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: requestResultInputSchema,
  outputSchema: requestResultOutputSchema,
  handler: requestResultHandler,
};

// ---------------------------------------------------------------------------
// newegg_sbn_warehouses_list
// ---------------------------------------------------------------------------
const warehousesInputSchema = z
  .strictObject({
    warehouseCode: z
      .string()
      .regex(/^\d{1,3}$/, "a 1-3 digit Newegg warehouse code, e.g. 10")
      .optional()
      .describe("Return only this warehouse; omit to request every SBN warehouse."),
  })
  .describe("Optional warehouse filter.");

const warehousesOutputSchema = z.object({
  marketplace: marketplaceSchema,
  warehouses: z.array(
    z.object({
      warehouseCode: z.string(),
      allowBulkItem: z.boolean().optional(),
      allowSmallItem: z.boolean().optional(),
      address: addressSchema,
    }),
  ),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function warehousesHandler(
  input: z.infer<typeof warehousesInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await ctx.client.sbn.listWarehouses(
      input.warehouseCode !== undefined ? { warehouseCode: input.warehouseCode } : {},
    );
    return okResult({
      marketplace: result.marketplace,
      warehouses: result.warehouses.map((warehouse) => ({
        warehouseCode: warehouse.warehouseCode,
        allowBulkItem: warehouse.allowBulkItem,
        allowSmallItem: warehouse.allowSmallItem,
        address: warehouse.address,
      })),
      correlationId: result.correlationId,
      rateLimit: serializeRateLimit(result.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const sbnWarehousesListTool: ToolDefinition<
  typeof warehousesInputSchema,
  typeof warehousesOutputSchema
> = {
  name: TOOL_NAMES.sbnWarehousesList,
  title: "List Shipped-by-Newegg inbound warehouses",
  description:
    "Get Warehouse List: Newegg's SBN inbound warehouses (code, whether bulk and/or small items " +
    "are accepted, and the ship-to address), or one warehouse by code. Newegg.com and Newegg " +
    "Business only. Newegg allows 1,000 requests/minute. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: warehousesInputSchema,
  outputSchema: warehousesOutputSchema,
  handler: warehousesHandler,
};
