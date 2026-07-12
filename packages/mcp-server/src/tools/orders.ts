/**
 * Read-only order tools: `newegg_orders_list`, `newegg_orders_get`, and
 * `newegg_orders_get_status`. All three consume only the SDK's public `OrdersApi` (which never
 * mutates) and map fields explicitly — SDK `raw` payloads are never requested or returned.
 * Because they are reads, they register unconditionally (independent of write-gating).
 */
import { z } from "zod";
import type { ListOrdersInput, Order, OrderStatusSnapshot } from "@devino/newegg-marketplace-sdk";
import {
  errorResult,
  marketplaceSchema,
  mapErrorToPayload,
  okResult,
  rateLimitOutputSchema,
  serializeRateLimit,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./shared.js";
import { TOOL_NAMES } from "./names.js";

// ---------------------------------------------------------------------------
// shared order schemas (output)
// ---------------------------------------------------------------------------
const timestampSchema = z.object({ raw: z.string(), iso: z.string().optional() });

const orderStatusSchema = z.enum([
  "unshipped",
  "partiallyShipped",
  "shipped",
  "invoiced",
  "voided",
  "paymentPending",
  "unknown",
]);
const orderItemStatusSchema = z.enum(["unshipped", "shipped", "cancelled", "unknown"]);
const salesChannelSchema = z.enum(["newegg", "multiChannel", "replacement", "nws", "unknown"]);
const fulfillmentSchema = z.enum(["seller", "newegg"]);

const shipToSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  company: z.string().optional(),
  address1: z.string().optional(),
  address2: z.string().optional(),
  city: z.string().optional(),
  stateCode: z.string().optional(),
  zipCode: z.string().optional(),
  countryCode: z.string().optional(),
});

const customerSchema = z.object({
  name: z.string().optional(),
  phoneNumber: z.string().optional(),
  emailAddress: z.string().optional(),
  shipTo: shipToSchema.optional(),
});

const amountsSchema = z.object({
  itemAmount: z.number().optional(),
  shippingAmount: z.number().optional(),
  discountAmount: z.number().optional(),
  refundAmount: z.number().optional(),
  salesTax: z.number().optional(),
  vatTotal: z.number().optional(),
  dutyTotal: z.number().optional(),
  recyclingFee: z.number().optional(),
  total: z.number().optional(),
});

const orderItemSchema = z.object({
  sellerPartNumber: z.string().optional(),
  neweggItemNumber: z.string().optional(),
  mfrPartNumber: z.string().optional(),
  upc: z.string().optional(),
  description: z.string().optional(),
  orderedQty: z.number().optional(),
  shippedQty: z.number().optional(),
  unitPrice: z.number().optional(),
  extendedUnitPrice: z.number().optional(),
  extendedShippingCharge: z.number().optional(),
  status: orderItemStatusSchema,
  statusDescription: z.string().optional(),
  buyerRequestedCancel: z.boolean().optional(),
});

const orderPackageSchema = z.object({
  shipCarrier: z.string().optional(),
  shipService: z.string().optional(),
  trackingNumber: z.string().optional(),
  shipDate: timestampSchema.optional(),
  sellerPartNumber: z.string().optional(),
  mfrPartNumber: z.string().optional(),
  shippedQty: z.number().optional(),
  memo: z.string().optional(),
});

const orderSchema = z.object({
  orderNumber: z.string(),
  sellerOrderNumber: z.string().optional(),
  invoiceNumber: z.string().optional(),
  status: orderStatusSchema,
  statusDescription: z.string().optional(),
  downloaded: z.boolean().optional(),
  orderDate: timestampSchema.optional(),
  autoVoidTime: timestampSchema.optional(),
  isAutoVoid: z.boolean().optional(),
  salesChannel: salesChannelSchema.optional(),
  fulfillment: fulfillmentSchema.optional(),
  currencyCode: z.string().optional(),
  customer: customerSchema.optional(),
  shipService: z.string().optional(),
  signatureRequired: z.boolean().optional(),
  onTimeShipDueDate: timestampSchema.optional(),
  deliverDueDate: timestampSchema.optional(),
  amounts: amountsSchema,
  quantity: z.number().optional(),
  items: z.array(orderItemSchema),
  packages: z.array(orderPackageSchema),
});

/** Maps an SDK `Order` to a JSON-safe structured payload (the Order type carries no `raw`). */
function serializeOrder(order: Order): Record<string, unknown> {
  return {
    orderNumber: order.orderNumber,
    sellerOrderNumber: order.sellerOrderNumber,
    invoiceNumber: order.invoiceNumber,
    status: order.status,
    statusDescription: order.statusDescription,
    downloaded: order.downloaded,
    orderDate: order.orderDate,
    autoVoidTime: order.autoVoidTime,
    isAutoVoid: order.isAutoVoid,
    salesChannel: order.salesChannel,
    fulfillment: order.fulfillment,
    currencyCode: order.currencyCode,
    customer: order.customer,
    shipService: order.shipService,
    signatureRequired: order.signatureRequired,
    onTimeShipDueDate: order.onTimeShipDueDate,
    deliverDueDate: order.deliverDueDate,
    amounts: order.amounts,
    quantity: order.quantity,
    items: order.items,
    packages: order.packages,
  };
}

function serializeOrderStatus(snapshot: OrderStatusSnapshot): Record<string, unknown> {
  return {
    marketplace: snapshot.marketplace,
    orderNumber: snapshot.orderNumber,
    status: snapshot.status,
    statusName: snapshot.statusName,
    downloaded: snapshot.downloaded,
    salesChannel: snapshot.salesChannel,
    fulfillment: snapshot.fulfillment,
    correlationId: snapshot.correlationId,
    rateLimit: serializeRateLimit(snapshot.rateLimit),
  };
}

/** Order number input: a positive integer or its string form (Newegg order numbers are ints). */
const orderNumberSchema = z
  .union([z.string().min(1).max(32), z.number().int().positive()])
  .describe("A Newegg order number.");

/** ISO 8601 (or `YYYY-MM-DD HH:mm:ss`) → Date so the SDK renders Pacific; otherwise pass through. */
function toDateInput(value: string | undefined): Date | string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date;
}

// ---------------------------------------------------------------------------
// newegg_orders_list
// ---------------------------------------------------------------------------
const listInputSchema = z
  .strictObject({
    orderNumbers: z
      .array(orderNumberSchema)
      .min(1)
      .optional()
      .describe("Look up specific order numbers; when set, Newegg ignores all other filters."),
    sellerOrderNumbers: z.array(z.string().min(1)).min(1).optional(),
    status: z
      .enum(["unshipped", "partiallyShipped", "shipped", "invoiced", "voided", "paymentPending"])
      .optional()
      .describe("Filter by order status."),
    type: z
      .enum(["all", "sbn", "sbs", "multiChannel", "nws"])
      .optional()
      .describe("Filter by fulfillment/channel type."),
    includeDownloaded: z
      .boolean()
      .optional()
      .describe("false excludes orders already marked downloaded. Defaults to including all."),
    premierOrder: z.enum(["all", "premierOnly", "noPremier"]).optional(),
    dateFrom: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Lower bound on order date, ISO 8601 (e.g. 2024-01-01T00:00:00Z), Pacific-converted.",
      ),
    dateTo: z.string().min(1).optional().describe("Upper bound on order date (see dateFrom)."),
    countryCode: z.string().min(1).max(3).optional().describe("ISO 3-digit country code."),
    page: z.number().int().min(1).optional().describe("1-based page index (default 1)."),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Page size, max 100 (default 100)."),
  })
  .describe("Order-search criteria; all fields optional (omit all to match every order).");

const listOutputSchema = z.object({
  marketplace: marketplaceSchema,
  orders: z.array(orderSchema),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
  totalPageCount: z.number(),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function listHandler(
  input: z.infer<typeof listInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const listInput: ListOrdersInput = {};
  if (input.orderNumbers !== undefined) listInput.orderNumbers = input.orderNumbers;
  if (input.sellerOrderNumbers !== undefined)
    listInput.sellerOrderNumbers = input.sellerOrderNumbers;
  if (input.status !== undefined) listInput.status = input.status;
  if (input.type !== undefined) listInput.type = input.type;
  if (input.includeDownloaded !== undefined) listInput.includeDownloaded = input.includeDownloaded;
  if (input.premierOrder !== undefined) listInput.premierOrder = input.premierOrder;
  const dateFrom = toDateInput(input.dateFrom);
  if (dateFrom !== undefined) listInput.dateFrom = dateFrom;
  const dateTo = toDateInput(input.dateTo);
  if (dateTo !== undefined) listInput.dateTo = dateTo;
  if (input.countryCode !== undefined) listInput.countryCode = input.countryCode;
  if (input.page !== undefined) listInput.page = input.page;
  if (input.pageSize !== undefined) listInput.pageSize = input.pageSize;

  try {
    const page = await ctx.client.orders.list(listInput);
    return okResult({
      marketplace: page.marketplace,
      orders: page.orders.map(serializeOrder),
      page: page.page,
      pageSize: page.pageSize,
      totalCount: page.totalCount,
      totalPageCount: page.totalPageCount,
      correlationId: page.correlationId,
      rateLimit: serializeRateLimit(page.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const ordersListTool: ToolDefinition<typeof listInputSchema, typeof listOutputSchema> = {
  name: TOOL_NAMES.ordersList,
  title: "List Newegg orders",
  description:
    "Search Newegg Marketplace orders by criteria (status, type, date range, order/seller order " +
    "numbers, country, premier) with pagination. Returns a page of fully-detailed orders " +
    "including line items and shipment packages. Read-only: this never changes any order.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: listInputSchema,
  outputSchema: listOutputSchema,
  handler: listHandler,
};

// ---------------------------------------------------------------------------
// newegg_orders_get
// ---------------------------------------------------------------------------
const getInputSchema = z
  .strictObject({ orderNumber: orderNumberSchema })
  .describe("The order number to fetch full detail for.");

const getOutputSchema = z.object({
  found: z.boolean(),
  order: orderSchema.optional(),
});

async function getHandler(
  input: z.infer<typeof getInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const order = await ctx.client.orders.tryGet(input.orderNumber);
    return order === undefined
      ? okResult({ found: false })
      : okResult({ found: true, order: serializeOrder(order) });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const ordersGetTool: ToolDefinition<typeof getInputSchema, typeof getOutputSchema> = {
  name: TOOL_NAMES.ordersGet,
  title: "Get a Newegg order",
  description:
    "Fetch one Newegg Marketplace order's full detail by order number (line items, shipment " +
    "packages, customer ship-to, amounts, status). Returns found=false when no such order " +
    "exists for this seller. Read-only: this never changes any order.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: getInputSchema,
  outputSchema: getOutputSchema,
  handler: getHandler,
};

// ---------------------------------------------------------------------------
// newegg_orders_get_status
// ---------------------------------------------------------------------------
const getStatusInputSchema = z
  .strictObject({ orderNumber: orderNumberSchema })
  .describe("The order number to fetch a lightweight status for.");

const orderStatusSnapshotSchema = z.object({
  marketplace: marketplaceSchema,
  orderNumber: z.string(),
  status: orderStatusSchema,
  statusName: z.string().optional(),
  downloaded: z.boolean().optional(),
  salesChannel: salesChannelSchema.optional(),
  fulfillment: fulfillmentSchema.optional(),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

const getStatusOutputSchema = z.object({
  found: z.boolean(),
  orderStatus: orderStatusSnapshotSchema.optional(),
});

async function getStatusHandler(
  input: z.infer<typeof getStatusInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const snapshot = await ctx.client.orders.tryGetStatus(input.orderNumber);
    return snapshot === undefined
      ? okResult({ found: false })
      : okResult({ found: true, orderStatus: serializeOrderStatus(snapshot) });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const ordersGetStatusTool: ToolDefinition<
  typeof getStatusInputSchema,
  typeof getStatusOutputSchema
> = {
  name: TOOL_NAMES.ordersGetStatus,
  title: "Get Newegg order status",
  description:
    "Look up a single Newegg Marketplace order's status (status code/name, downloaded flag, " +
    "sales channel, fulfillment) by order number — lighter than newegg_orders_get. Returns " +
    "found=false when no such order exists for this seller. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: getStatusInputSchema,
  outputSchema: getStatusOutputSchema,
  handler: getStatusHandler,
};
