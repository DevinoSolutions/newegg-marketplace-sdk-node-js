/**
 * Read-only RMA / courtesy-refund tools: `newegg_rma_list`, `newegg_rma_get`,
 * `newegg_refund_list` and `newegg_refund_status`. They consume only the SDK's public `RmaApi` /
 * `RefundsApi` (reads only; contracts §18) and register unconditionally (never write-gated).
 * There is deliberately NO tool that submits, edits, processes or rejects an RMA or issues a
 * courtesy refund.
 *
 * PII policy (docs/mcp-security.md): every field is mapped EXPLICITLY. The customer block (name,
 * phone, masked email, ship-to address), the free-text RMA / item / courtesy notes, the issuing
 * and editing user names (can be a seller e-mail address) and the return-label tracking number and
 * URL are never returned, and SDK `raw` payloads are never requested. What remains is business
 * data a seller needs to triage returns: RMA / order numbers, status, type, reason, quantities and
 * amounts (in the marketplace currency).
 */
import { z } from "zod";
import type {
  CourtesyRefund,
  CourtesyRefundRequestStatus,
  ListCourtesyRefundRequestsInput,
  ListCourtesyRefundsInput,
  ListRmasInput,
  Rma,
  RmaItem,
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
const currencySchema = z.enum(["USD", "CAD"]);

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

const pageSchema = z.number().int().min(1).optional().describe("1-based page index (default 1).");
const pageSizeSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("Page size, max 100 (default 100).");

const rmaNumberSchema = z
  .union([z.string().regex(/^\d{1,18}$/), z.number().int().positive()])
  .describe("A Newegg RMA number (digits only).");

const rmaStatusSchema = z.enum([
  "open",
  "received",
  "rejected",
  "voided",
  "closed",
  "processing",
  "unknown",
]);
const rmaTypeSchema = z.enum(["replacement", "refund", "unknown"]);
const rmaReasonSchema = z.enum([
  "itemDamaged",
  "defective",
  "incompatible",
  "noLongerNeeded",
  "notAsDescribed",
  "orderedWrongItem",
  "sentWrongItem",
  "unsatisfied",
  "other",
  "unknown",
]);

// ---------------------------------------------------------------------------
// RMA output (explicit, PII-free mapping)
// ---------------------------------------------------------------------------
const rmaItemSchema = z.object({
  sellerPartNumber: z.string().optional(),
  neweggItemNumber: z.string().optional(),
  mfrPartNumber: z.string().optional(),
  description: z.string().optional(),
  unitPrice: z.number().optional(),
  returnQuantity: z.number().optional(),
  returnUnitPrice: z.number().optional(),
  refundShippingPrice: z.number().optional(),
  rmaTotalRefund: z.number().optional(),
  shippedBy: z.enum(["seller", "newegg"]).optional(),
  reason: rmaReasonSchema,
  reasonDescription: z.string().optional(),
  unopened: z.boolean().optional(),
});

const rmaSchema = z.object({
  rmaNumber: z.string(),
  type: rmaTypeSchema,
  status: rmaStatusSchema,
  statusDescription: z.string().optional(),
  sellerRmaNumber: z.string().optional(),
  replacementOrderNumber: z.string().optional(),
  rmaDate: timestampSchema.optional(),
  receiveDate: timestampSchema.optional(),
  orderNumber: z.string().optional(),
  orderDate: timestampSchema.optional(),
  invoiceNumber: z.string().optional(),
  orderAmount: z.number().optional(),
  availableRefundAmount: z.number().optional(),
  priorRefundAmount: z.number().optional(),
  refundGstOrHstAmount: z.number().optional(),
  refundPstOrQstAmount: z.number().optional(),
  processedBy: z.enum(["seller", "newegg"]).optional(),
  shipMethodDescription: z.string().optional(),
  returnLabelCost: z.number().optional(),
  returnLabelPaidBy: z.string().optional(),
  items: z.array(rmaItemSchema),
});

function serializeRmaItem(item: RmaItem): Record<string, unknown> {
  return {
    sellerPartNumber: item.sellerPartNumber,
    neweggItemNumber: item.neweggItemNumber,
    mfrPartNumber: item.mfrPartNumber,
    description: item.description,
    unitPrice: item.unitPrice,
    returnQuantity: item.returnQuantity,
    returnUnitPrice: item.returnUnitPrice,
    refundShippingPrice: item.refundShippingPrice,
    rmaTotalRefund: item.rmaTotalRefund,
    shippedBy: item.shippedBy,
    reason: item.reason,
    reasonDescription: item.reasonDescription,
    unopened: item.unopened,
  };
}

/** Maps an SDK `Rma` field by field: customer, notes, memo, issue user and tracking are dropped. */
export function serializeRma(rma: Rma): Record<string, unknown> {
  return {
    rmaNumber: rma.rmaNumber,
    type: rma.type,
    status: rma.status,
    statusDescription: rma.statusDescription,
    sellerRmaNumber: rma.sellerRmaNumber,
    replacementOrderNumber: rma.replacementOrderNumber,
    rmaDate: rma.rmaDate,
    receiveDate: rma.receiveDate,
    orderNumber: rma.orderNumber,
    orderDate: rma.orderDate,
    invoiceNumber: rma.invoiceNumber,
    orderAmount: rma.orderAmount,
    availableRefundAmount: rma.availableRefundAmount,
    priorRefundAmount: rma.priorRefundAmount,
    refundGstOrHstAmount: rma.refundGstOrHstAmount,
    refundPstOrQstAmount: rma.refundPstOrQstAmount,
    processedBy: rma.processedBy,
    shipMethodDescription: rma.shipMethodDescription,
    returnLabelCost: rma.returnLabel?.estimatedCost,
    returnLabelPaidBy: rma.returnLabel?.paidBy,
    items: rma.items.map(serializeRmaItem),
  };
}

// ---------------------------------------------------------------------------
// newegg_rma_list
// ---------------------------------------------------------------------------
const rmaListInputSchema = z
  .strictObject({
    keywordType: z
      .enum(["rmaNumber", "orderNumber", "customerName", "sellerRmaNumber"])
      .optional()
      .describe("What keywordValue searches. Requires keywordValue."),
    keywordValue: z.string().min(1).max(100).optional(),
    status: z
      .enum(["open", "received", "rejected", "voided", "closed", "processing"])
      .optional()
      .describe("Filter by RMA status. Note: received RMAs are not visible in Seller Portal."),
    type: z.enum(["replacement", "refund"]).optional(),
    processedBy: z.enum(["seller", "newegg"]).optional(),
    dateFrom: dateInputSchema("Lower bound on the RMA date"),
    dateTo: dateInputSchema("Upper bound on the RMA date"),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .refine((value) => (value.keywordType === undefined) === (value.keywordValue === undefined), {
    message: "keywordType and keywordValue must be provided together",
  })
  .describe("RMA search criteria; all fields optional (omit all to list every RMA).");

const rmaListOutputSchema = z.object({
  marketplace: marketplaceSchema,
  currency: currencySchema,
  rmas: z.array(rmaSchema),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
  totalPageCount: z.number(),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function rmaListHandler(
  input: z.infer<typeof rmaListInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const listInput: ListRmasInput = {};
  if (input.keywordType !== undefined && input.keywordValue !== undefined) {
    listInput.keyword = { type: input.keywordType, value: input.keywordValue };
  }
  if (input.status !== undefined) listInput.status = input.status;
  if (input.type !== undefined) listInput.type = input.type;
  if (input.processedBy !== undefined) listInput.processedBy = input.processedBy;
  const dateFrom = toDateInput(input.dateFrom);
  if (dateFrom !== undefined) listInput.dateFrom = dateFrom;
  const dateTo = toDateInput(input.dateTo);
  if (dateTo !== undefined) listInput.dateTo = dateTo;
  if (input.page !== undefined) listInput.page = input.page;
  if (input.pageSize !== undefined) listInput.pageSize = input.pageSize;
  try {
    const page = await ctx.client.rma.list(listInput);
    return okResult({
      marketplace: page.marketplace,
      currency: page.currency,
      rmas: page.rmas.map(serializeRma),
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

export const rmaListTool: ToolDefinition<typeof rmaListInputSchema, typeof rmaListOutputSchema> = {
  name: TOOL_NAMES.rmaList,
  title: "List Newegg RMAs",
  description:
    "Search Newegg Marketplace RMAs (returns/replacements) by status, type, who processed it, " +
    "keyword (RMA number, order number, seller RMA number) and date range, with pagination. " +
    "Returns business fields only (RMA/order numbers, status, reason, quantities, amounts in the " +
    "marketplace currency): customer names, phones, e-mails, addresses, notes and tracking " +
    "numbers are never returned. Read-only: this never creates, edits, processes or rejects an RMA.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: rmaListInputSchema,
  outputSchema: rmaListOutputSchema,
  handler: rmaListHandler,
};

// ---------------------------------------------------------------------------
// newegg_rma_get
// ---------------------------------------------------------------------------
const rmaGetInputSchema = z
  .strictObject({ rmaNumber: rmaNumberSchema })
  .describe("The RMA number to fetch.");

const rmaGetOutputSchema = z.object({
  found: z.boolean(),
  marketplace: marketplaceSchema.optional(),
  currency: currencySchema.optional(),
  rma: rmaSchema.optional(),
});

async function rmaGetHandler(
  input: z.infer<typeof rmaGetInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const rma = await ctx.client.rma.tryGet(input.rmaNumber);
    if (rma === undefined) return okResult({ found: false });
    return okResult({
      found: true,
      marketplace: ctx.client.marketplace,
      currency: ctx.client.marketplace === "ca" ? "CAD" : "USD",
      rma: serializeRma(rma),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const rmaGetTool: ToolDefinition<typeof rmaGetInputSchema, typeof rmaGetOutputSchema> = {
  name: TOOL_NAMES.rmaGet,
  title: "Get a Newegg RMA",
  description:
    "Fetch one Newegg Marketplace RMA by RMA number (status, type, linked order, items, reasons, " +
    "amounts). Returns found=false when no such RMA exists for this seller. Customer PII, notes " +
    "and tracking numbers are never returned. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: rmaGetInputSchema,
  outputSchema: rmaGetOutputSchema,
  handler: rmaGetHandler,
};

// ---------------------------------------------------------------------------
// courtesy refund output (explicit, PII-free mapping)
// ---------------------------------------------------------------------------
const refundStatusSchema = z.enum(["open", "closed", "void", "unknown"]);
const refundReasonSchema = z.enum([
  "negativeCustomerFeedback",
  "pricingError",
  "wrongItemInformation",
  "shippingDelay",
  "packageNotReceived",
  "customerCourtesy",
  "unknown",
]);

const refundSchema = z.object({
  courtesyRefundId: z.string(),
  orderNumber: z.string().optional(),
  orderAmount: z.number().optional(),
  invoiceNumber: z.string().optional(),
  refundAmount: z.number().optional(),
  reason: refundReasonSchema,
  reasonDescription: z.string().optional(),
  status: refundStatusSchema,
  issuedByNewegg: z.boolean().optional(),
  createdDate: timestampSchema.optional(),
  editedDate: timestampSchema.optional(),
});

/** Maps a courtesy refund field by field: the customer note and creator/editor names are dropped. */
function serializeRefund(refund: CourtesyRefund): Record<string, unknown> {
  return {
    courtesyRefundId: refund.courtesyRefundId,
    orderNumber: refund.orderNumber,
    orderAmount: refund.orderAmount,
    invoiceNumber: refund.invoiceNumber,
    refundAmount: refund.refundAmount,
    reason: refund.reason,
    reasonDescription: refund.reasonDescription,
    status: refund.status,
    issuedByNewegg: refund.issuedByNewegg,
    createdDate: refund.createdDate,
    editedDate: refund.editedDate,
  };
}

// ---------------------------------------------------------------------------
// newegg_refund_list
// ---------------------------------------------------------------------------
const refundListInputSchema = z
  .strictObject({
    keywordType: z
      .enum(["courtesyRefundId", "orderNumber", "customerName"])
      .optional()
      .describe("What keywordValue searches. Requires keywordValue."),
    keywordValue: z.string().min(1).max(100).optional(),
    status: z.enum(["open", "closed", "void"]).optional(),
    dateFrom: dateInputSchema("Lower bound on the courtesy refund date"),
    dateTo: dateInputSchema("Upper bound on the courtesy refund date"),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .refine((value) => (value.keywordType === undefined) === (value.keywordValue === undefined), {
    message: "keywordType and keywordValue must be provided together",
  })
  .describe("Courtesy refund search criteria; all fields optional.");

const refundListOutputSchema = z.object({
  marketplace: marketplaceSchema,
  currency: currencySchema,
  refunds: z.array(refundSchema),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
  totalPageCount: z.number(),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function refundListHandler(
  input: z.infer<typeof refundListInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const listInput: ListCourtesyRefundsInput = {};
  if (input.keywordType !== undefined && input.keywordValue !== undefined) {
    listInput.keyword = { type: input.keywordType, value: input.keywordValue };
  }
  if (input.status !== undefined) listInput.status = input.status;
  const dateFrom = toDateInput(input.dateFrom);
  if (dateFrom !== undefined) listInput.dateFrom = dateFrom;
  const dateTo = toDateInput(input.dateTo);
  if (dateTo !== undefined) listInput.dateTo = dateTo;
  if (input.page !== undefined) listInput.page = input.page;
  if (input.pageSize !== undefined) listInput.pageSize = input.pageSize;
  try {
    const page = await ctx.client.refunds.list(listInput);
    return okResult({
      marketplace: page.marketplace,
      currency: page.currency,
      refunds: page.refunds.map(serializeRefund),
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

export const refundListTool: ToolDefinition<
  typeof refundListInputSchema,
  typeof refundListOutputSchema
> = {
  name: TOOL_NAMES.refundList,
  title: "List Newegg courtesy refunds",
  description:
    "Search Newegg Marketplace courtesy refunds (refunds issued without a return) by id, order " +
    "number, status and date range, with pagination. Returns order/refund amounts (marketplace " +
    "currency), reason and status; the note to the customer and user names are never returned. " +
    "Limited by Newegg to 30 requests/minute. Read-only: this never issues a refund.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: refundListInputSchema,
  outputSchema: refundListOutputSchema,
  handler: refundListHandler,
};

// ---------------------------------------------------------------------------
// newegg_refund_status
// ---------------------------------------------------------------------------
const requestStateSchema = z.enum([
  "submitted",
  "inProgress",
  "finished",
  "failed",
  "cancelled",
  "unknown",
]);

const requestStatusSchema = z.object({
  requestId: z.string(),
  requestDate: timestampSchema.optional(),
  state: requestStateSchema,
  processMemo: z.string().optional(),
  refund: refundSchema.optional(),
});

const refundStatusInputSchema = z
  .strictObject({
    requestIds: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(100)
      .optional()
      .describe("Courtesy refund request ids; when set, Newegg ignores every other filter."),
    status: z.enum(["submitted", "inProgress", "finished", "failed", "cancelled"]).optional(),
    dateFrom: dateInputSchema("Lower bound on the request date"),
    dateTo: dateInputSchema("Upper bound on the request date"),
    maxCount: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum records (default 100)."),
  })
  .describe("Courtesy refund request status criteria; all fields optional.");

const refundStatusOutputSchema = z.object({
  marketplace: marketplaceSchema,
  currency: currencySchema,
  requests: z.array(requestStatusSchema),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

/** Failure detail from Newegg's processor; bounded so it cannot flood tool output. */
function clip(text: string | undefined, max = 500): string | undefined {
  if (text === undefined) return undefined;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function serializeRequestStatus(status: CourtesyRefundRequestStatus): Record<string, unknown> {
  return {
    requestId: status.requestId,
    requestDate: status.requestDate,
    state: status.state,
    processMemo: clip(status.processMemo),
    refund: status.refund !== undefined ? serializeRefund(status.refund) : undefined,
  };
}

async function refundStatusHandler(
  input: z.infer<typeof refundStatusInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const listInput: ListCourtesyRefundRequestsInput = {};
  if (input.requestIds !== undefined) listInput.requestIds = input.requestIds;
  if (input.status !== undefined) listInput.status = input.status;
  const dateFrom = toDateInput(input.dateFrom);
  if (dateFrom !== undefined) listInput.dateFrom = dateFrom;
  const dateTo = toDateInput(input.dateTo);
  if (dateTo !== undefined) listInput.dateTo = dateTo;
  if (input.maxCount !== undefined) listInput.maxCount = input.maxCount;
  try {
    const result = await ctx.client.refunds.listRequests(listInput);
    return okResult({
      marketplace: result.marketplace,
      currency: result.currency,
      requests: result.requests.map(serializeRequestStatus),
      correlationId: result.correlationId,
      rateLimit: serializeRateLimit(result.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const refundStatusTool: ToolDefinition<
  typeof refundStatusInputSchema,
  typeof refundStatusOutputSchema
> = {
  name: TOOL_NAMES.refundStatus,
  title: "Get Newegg courtesy refund request status",
  description:
    "Check the processing state (submitted, in progress, finished, failed, cancelled) of courtesy " +
    "refund requests by request id, status or date range; a finished request includes the " +
    "resulting refund. Customer notes and user names are never returned. Read-only: this never " +
    "issues or changes a refund.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: refundStatusInputSchema,
  outputSchema: refundStatusOutputSchema,
  handler: refundStatusHandler,
};
