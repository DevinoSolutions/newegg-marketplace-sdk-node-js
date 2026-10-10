/**
 * Read-only Reports Management tools: `newegg_reports_settlement_summary`,
 * `newegg_reports_settlement_transactions`, `newegg_reports_daily_inventory`,
 * `newegg_reports_daily_price` and `newegg_reports_status`. They consume only the SDK's public
 * `ReportsApi` - report submission creates a report job and mutates nothing on the seller account
 * (contracts §12 / §17) - and register unconditionally (independent of write-gating).
 *
 * File-style reports (daily inventory / price) are answered with an FTP URL that embeds
 * credentials. The SDK downloads and parses the file itself and never hands the URL out, so no
 * tool output can contain it; only parsed rows, a row count and the file name are returned.
 *
 * Each report tool waits up to `waitSeconds` for the async report. If it is still processing, the
 * tool returns `pending: true` with a `requestId` for `newegg_reports_status` - resubmitting is
 * wrong (submissions are limited to 100/hour).
 */
import { z } from "zod";
import { ReportTimeoutError } from "@devino/newegg-marketplace-sdk";
import type {
  CollectedReport,
  DownloadedReport,
  ItemBasicInfoRow,
  NeweggClient,
  Order,
  ReportWaitOptions,
} from "@devino/newegg-marketplace-sdk";
import { serializeRma } from "./rma.js";
import {
  errorResult,
  mapErrorToPayload,
  marketplaceSchema,
  okResult,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./shared.js";
import { TOOL_NAMES } from "./names.js";

/** Default bounded wait before returning pending (seconds). */
const DEFAULT_WAIT_SECONDS = 55;
/** Rows returned per call unless the caller asks for fewer/more (hard cap {@link MAX_LIMIT}). */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// shared schemas + helpers
// ---------------------------------------------------------------------------
const waitSecondsSchema = z
  .number()
  .int()
  .min(5)
  .max(115)
  .optional()
  .describe("How long to wait for the async report before returning pending (default 55).");

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .optional()
  .describe(`Maximum rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`);

const reportDateSchema = z
  .string()
  .min(8)
  .max(32)
  .describe("Pacific Time date: YYYY-MM-DD (e.g. 2026-09-30) or M/D/YYYY H:mm:ss.");

const rowSchema = z.record(z.string(), z.unknown());

const reportOutputSchema = z.object({
  marketplace: marketplaceSchema,
  pending: z.boolean(),
  requestId: z.string().optional(),
  rows: z.array(rowSchema).optional(),
  totalRows: z.number().optional().describe("Rows Newegg reports for the whole report."),
  returnedRows: z.number().optional(),
  truncated: z.boolean().optional().describe("true when more rows exist than were returned."),
  fileName: z.string().optional(),
  message: z.string().optional(),
});

const PENDING_MESSAGE =
  "The report is still processing at Newegg. Call newegg_reports_status with this requestId " +
  "and the same reportType (do NOT resubmit - submissions are limited to 100/hour).";

function pendingResult(marketplace: string, error: ReportTimeoutError): ToolResult {
  return okResult({
    marketplace,
    pending: true,
    requestId: error.requestId,
    message: PENDING_MESSAGE,
  });
}

function identityRow(row: object): Record<string, unknown> {
  return { ...row };
}

/** `map` turns an SDK row into the explicit, PII-free tool row (identity for the money reports). */
function pagedOutput<Row extends object>(
  collected: CollectedReport<Row>,
  limit: number,
  map: (row: Row) => Record<string, unknown> = identityRow,
): Record<string, unknown> {
  const rows = collected.rows.slice(0, limit).map(map);
  return {
    marketplace: collected.marketplace,
    pending: false,
    requestId: collected.requestId,
    rows,
    totalRows: collected.totalCount,
    returnedRows: rows.length,
    truncated: rows.length < collected.totalCount,
  };
}

function fileOutput<Row extends object>(
  downloaded: DownloadedReport<Row>,
  limit: number,
  map: (row: Row) => Record<string, unknown> = identityRow,
): Record<string, unknown> {
  const rows = downloaded.rows.slice(0, limit).map(map);
  return {
    marketplace: downloaded.marketplace,
    pending: false,
    requestId: downloaded.requestId,
    ...(downloaded.fileName !== undefined ? { fileName: downloaded.fileName } : {}),
    rows,
    totalRows: downloaded.totalRows,
    returnedRows: rows.length,
    truncated: rows.length < downloaded.totalRows,
  };
}

function waitOptions(waitSeconds: number | undefined, limit: number): ReportWaitOptions {
  return {
    timeoutMs: (waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000,
    // Only fetch the pages the caller can actually receive.
    maxPages: Math.max(1, Math.ceil(limit / PAGE_SIZE)),
    maxRows: limit,
  };
}

/** Runs a report; turns a retryable wait timeout into a pending result. */
async function runReport(
  ctx: ToolContext,
  run: () => Promise<Record<string, unknown>>,
): Promise<ToolResult> {
  try {
    return okResult(await run());
  } catch (error) {
    if (error instanceof ReportTimeoutError && error.retryable) {
      return pendingResult(ctx.client.marketplace, error);
    }
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

// ---------------------------------------------------------------------------
// newegg_reports_settlement_summary
// ---------------------------------------------------------------------------
const settlementSummaryInputSchema = z
  .strictObject({
    dateFrom: reportDateSchema.describe("Start of the settlement date range (Pacific Time)."),
    dateTo: reportDateSchema.describe("End of the settlement date range (Pacific Time)."),
    limit: limitSchema,
    waitSeconds: waitSecondsSchema,
  })
  .describe("Settlement date range for the Settlement Summary report.");

export const reportsSettlementSummaryTool: ToolDefinition<
  typeof settlementSummaryInputSchema,
  typeof reportOutputSchema
> = {
  name: TOOL_NAMES.reportsSettlementSummary,
  title: "Newegg settlement summary report",
  description:
    "Settlement Summary report: per-settlement item sales, shipping, taxes, refunds, Newegg fees " +
    "and the settlement total for a settlement date range (Pacific Time). Amounts are USD on " +
    "Newegg.com and Neweggbusiness.com and CAD on Newegg.ca; fields Newegg does not report are " +
    "omitted (never zero). Runs an async Newegg report and waits up to waitSeconds; if still " +
    "processing, returns pending=true with a requestId for newegg_reports_status. Read-only: " +
    "creates a report job and changes nothing on the seller account.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: settlementSummaryInputSchema,
  outputSchema: reportOutputSchema,
  handler: (input, ctx) =>
    runReport(ctx, async () =>
      pagedOutput(
        await ctx.client.reports.settlementSummary.waitForResult(
          { dateFrom: input.dateFrom, dateTo: input.dateTo },
          waitOptions(input.waitSeconds, input.limit ?? DEFAULT_LIMIT),
        ),
        input.limit ?? DEFAULT_LIMIT,
      ),
    ),
};

// ---------------------------------------------------------------------------
// newegg_reports_settlement_transactions
// ---------------------------------------------------------------------------
const TRANSACTION_TYPES = [
  "all",
  "order",
  "refund",
  "creditRequest",
  "chargeback",
  "monthlyFee",
  "fulfillByNeweggFee",
  "multiChannelFee",
  "rmaProcessingFee",
  "taxAndDuty",
  "storageFee",
  "rmaBuyoutFee",
  "adjustmentFee",
  "monthlyFeeByCreditCard",
  "sbnInboundFee",
  "merchandisingFee",
  "premierFee",
  "shippingLabelFee",
  "returnAndDisposalFee",
  "relabelingFee",
  "recyclingFeeOrEhf",
  "returnShippingLabelFee",
  "serviceFeeTax",
  "printShippingLabelService",
  "reservedBalance",
  "previousReservedBalance",
  "commissionIncentiveRefund",
  "unsoldListingFee",
  "orderProcessingFee",
  "salesTaxAndFees",
  "sbnInboundIncomplianceCharges",
  "sponsoredAds",
  "itemOverageFee",
] as const;

const settlementTransactionsInputSchema = z
  .strictObject({
    settlementDateFrom: reportDateSchema
      .optional()
      .describe("Range start (with settlementDateTo)."),
    settlementDateTo: reportDateSchema.optional().describe("Range end (with settlementDateFrom)."),
    settlementDate: reportDateSchema.optional().describe("A single settlement date."),
    settlementId: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe("A Newegg settlement id (digits)."),
    orderNumber: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe("Restrict to one Newegg order number (digits)."),
    transactionType: z
      .enum(TRANSACTION_TYPES)
      .optional()
      .describe("Transaction category filter (default all)."),
    limit: limitSchema,
    waitSeconds: waitSecondsSchema,
  })
  .describe(
    "Criteria for the Settlement Transaction report. Provide settlementId, OR settlementDate, " +
      "OR both settlementDateFrom and settlementDateTo (Newegg requires one of these).",
  );

export const reportsSettlementTransactionsTool: ToolDefinition<
  typeof settlementTransactionsInputSchema,
  typeof reportOutputSchema
> = {
  name: TOOL_NAMES.reportsSettlementTransactions,
  title: "Newegg settlement transaction report",
  description:
    "Settlement Transaction report: line-level transactions (orders, refunds, fees, adjustments) " +
    "inside settlements, with order number, SKU, Newegg item number, amount, shipping and " +
    "commission fee. Provide settlementId, OR settlementDate, OR both settlementDateFrom and " +
    "settlementDateTo (Pacific Time); optionally narrow by transactionType or orderNumber. " +
    "Amounts are USD (Newegg.com / Neweggbusiness.com) or CAD (Newegg.ca). Waits up to " +
    "waitSeconds; if still processing, returns pending=true with a requestId for " +
    "newegg_reports_status. Read-only: creates a report job and changes nothing.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: settlementTransactionsInputSchema,
  outputSchema: reportOutputSchema,
  handler: (input, ctx) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    return runReport(ctx, async () =>
      pagedOutput(
        await ctx.client.reports.settlementTransactions.waitForResult(
          {
            ...(input.settlementDateFrom !== undefined
              ? { settlementDateFrom: input.settlementDateFrom }
              : {}),
            ...(input.settlementDateTo !== undefined
              ? { settlementDateTo: input.settlementDateTo }
              : {}),
            ...(input.settlementDate !== undefined ? { settlementDate: input.settlementDate } : {}),
            ...(input.settlementId !== undefined ? { settlementId: input.settlementId } : {}),
            ...(input.orderNumber !== undefined ? { orderNumber: input.orderNumber } : {}),
            ...(input.transactionType !== undefined
              ? { transactionType: input.transactionType }
              : {}),
          },
          waitOptions(input.waitSeconds, limit),
        ),
        limit,
      ),
    );
  },
};

// ---------------------------------------------------------------------------
// newegg_reports_daily_inventory
// ---------------------------------------------------------------------------
const dailyInventoryInputSchema = z
  .strictObject({
    fulfillType: z
      .enum(["all", "seller", "newegg"])
      .optional()
      .describe("Fulfillment filter (default all)."),
    warehouses: z
      .array(z.string().regex(/^[A-Z]{3}$/))
      .max(20)
      .optional()
      .describe("US marketplace only: 3-letter ISO warehouse codes (default all)."),
    limit: limitSchema,
    waitSeconds: waitSecondsSchema,
  })
  .describe("Daily Inventory report filters.");

export const reportsDailyInventoryTool: ToolDefinition<
  typeof dailyInventoryInputSchema,
  typeof reportOutputSchema
> = {
  name: TOOL_NAMES.reportsDailyInventory,
  title: "Newegg daily inventory report",
  description:
    "Daily Inventory report: the seller's inventory for every item. US returns per-warehouse " +
    "quantities; Neweggbusiness.com and Newegg.ca return the default warehouse's quantity plus " +
    "currency, MSRP, MAP, selling price, shipping and activation status. The report file is " +
    "downloaded and parsed server-side; the file's credential-bearing download link is never " +
    "exposed. Returns at most `limit` rows plus totalRows. Waits up to waitSeconds; if still " +
    "processing, returns pending=true with a requestId for newegg_reports_status. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: dailyInventoryInputSchema,
  outputSchema: reportOutputSchema,
  handler: (input, ctx) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    return runReport(ctx, async () =>
      fileOutput(
        await ctx.client.reports.dailyInventory.waitForResult(
          {
            ...(input.fulfillType !== undefined ? { fulfillType: input.fulfillType } : {}),
            ...(input.warehouses !== undefined ? { warehouses: input.warehouses } : {}),
          },
          waitOptions(input.waitSeconds, limit),
        ),
        limit,
      ),
    );
  },
};

// ---------------------------------------------------------------------------
// newegg_reports_daily_price
// ---------------------------------------------------------------------------
const dailyPriceInputSchema = z
  .strictObject({
    countries: z
      .array(z.string().regex(/^[A-Z]{3}$/))
      .max(50)
      .optional()
      .describe("3-letter ISO destination countries (default all)."),
    limit: limitSchema,
    waitSeconds: waitSecondsSchema,
  })
  .describe("Daily Price report filters.");

export const reportsDailyPriceTool: ToolDefinition<
  typeof dailyPriceInputSchema,
  typeof reportOutputSchema
> = {
  name: TOOL_NAMES.reportsDailyPrice,
  title: "Newegg daily price report",
  description:
    "Daily Price report (Newegg.com marketplace only; B2B and CAN return an unsupported-operation " +
    "error - use newegg_reports_daily_inventory there): price, MSRP, MAP, shipping and activation " +
    "status per item and destination country. The file is downloaded and parsed server-side; its " +
    "credential-bearing download link is never exposed. Returns at most `limit` rows plus " +
    "totalRows. Waits up to waitSeconds; if still processing, returns pending=true with a " +
    "requestId for newegg_reports_status. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: dailyPriceInputSchema,
  outputSchema: reportOutputSchema,
  handler: (input, ctx) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    return runReport(ctx, async () =>
      fileOutput(
        await ctx.client.reports.dailyPrice.waitForResult(
          input.countries !== undefined ? { countries: input.countries } : {},
          waitOptions(input.waitSeconds, limit),
        ),
        limit,
      ),
    );
  },
};

// ---------------------------------------------------------------------------
// newegg_reports_item_basic_info
// ---------------------------------------------------------------------------
/**
 * Explicit field-by-field mapping: no `extra`, so an unmapped column can never leak. The long
 * bullet description and the image URL list are left out to keep 500-row answers small.
 */
function serializeItemRow(row: ItemBasicInfoRow): Record<string, unknown> {
  return {
    sellerPartNumber: row.sellerPartNumber,
    neweggItemNumber: row.neweggItemNumber,
    manufacturerPartNumber: row.manufacturerPartNumber,
    upc: row.upc,
    status: row.status,
    active: row.active,
    title: row.title,
    industry: row.industry,
    subcategory: row.subcategory,
    dateCreated: row.dateCreated,
    platform: row.platform,
    itemGroupId: row.itemGroupId,
    varieties: row.varieties,
  };
}

const itemBasicInfoInputSchema = z
  .strictObject({
    status: z
      .enum(["all", "active", "inactive"])
      .optional()
      .describe("Which listings to include (default all)."),
    limit: limitSchema,
    waitSeconds: waitSecondsSchema,
  })
  .describe("Item Basic Information report filters.");

export const reportsItemBasicInfoTool: ToolDefinition<
  typeof itemBasicInfoInputSchema,
  typeof reportOutputSchema
> = {
  name: TOOL_NAMES.reportsItemBasicInfo,
  title: "Newegg item basic information report (all listings)",
  description:
    "Item Basic Information report: every listing of the seller (seller part number / SKU, " +
    "Newegg item number, manufacturer part number, UPC, title, active or inactive, variant " +
    "group). This is the only way to enumerate ALL listings, e.g. to check whether a product " +
    "already has a listing. It carries NO price or stock (use newegg_reports_daily_inventory or " +
    "newegg_inventory_get / newegg_pricing_get for those). " +
    "The report file is downloaded and parsed server-side; its credential-bearing download link " +
    "is never exposed. Returns at most `limit` rows plus totalRows (use `status` to narrow). " +
    "Newegg builds it in about 1-4 minutes: waits up to waitSeconds, else returns pending=true " +
    "with a requestId for newegg_reports_status (reportType itemBasicInfo). Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: itemBasicInfoInputSchema,
  outputSchema: reportOutputSchema,
  handler: (input, ctx) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    return runReport(ctx, async () =>
      fileOutput(
        await ctx.client.reports.itemBasicInfo.waitForResult(
          input.status !== undefined ? { status: input.status } : {},
          waitOptions(input.waitSeconds, limit),
        ),
        limit,
        serializeItemRow,
      ),
    );
  },
};

// ---------------------------------------------------------------------------
// newegg_reports_order_list
// ---------------------------------------------------------------------------
/** USD on Newegg.com / Neweggbusiness.com, CAD on Newegg.ca. */
function currencyOf(client: NeweggClient): "USD" | "CAD" {
  return client.marketplace === "ca" ? "CAD" : "USD";
}

/**
 * PII-free order row. The customer block (name, phone, masked e-mail, ship-to address) and the
 * free-text package memo are NEVER mapped; everything else is business data.
 */
function serializeOrderRow(order: Order): Record<string, unknown> {
  return {
    orderNumber: order.orderNumber,
    sellerOrderNumber: order.sellerOrderNumber,
    invoiceNumber: order.invoiceNumber,
    status: order.status,
    statusDescription: order.statusDescription,
    downloaded: order.downloaded,
    orderDate: order.orderDate,
    isAutoVoid: order.isAutoVoid,
    salesChannel: order.salesChannel,
    fulfillment: order.fulfillment,
    shipService: order.shipService,
    amounts: order.amounts,
    quantity: order.quantity,
    items: order.items.map((item) => ({
      sellerPartNumber: item.sellerPartNumber,
      neweggItemNumber: item.neweggItemNumber,
      mfrPartNumber: item.mfrPartNumber,
      upc: item.upc,
      description: item.description,
      orderedQty: item.orderedQty,
      shippedQty: item.shippedQty,
      unitPrice: item.unitPrice,
      extendedUnitPrice: item.extendedUnitPrice,
      extendedShippingCharge: item.extendedShippingCharge,
      status: item.status,
      statusDescription: item.statusDescription,
    })),
    packages: order.packages.map((pkg) => ({
      shipCarrier: pkg.shipCarrier,
      shipService: pkg.shipService,
      shipDate: pkg.shipDate,
      sellerPartNumber: pkg.sellerPartNumber,
      shippedQty: pkg.shippedQty,
      items: pkg.items?.map((line) => ({
        sellerPartNumber: line.sellerPartNumber,
        mfrPartNumber: line.mfrPartNumber,
        shippedQty: line.shippedQty,
      })),
    })),
  };
}

const ORDER_LIST_STATUSES = [
  "unshipped",
  "partiallyShipped",
  "shipped",
  "invoiced",
  "voided",
  "paymentPending",
] as const;

const orderListInputSchema = z
  .strictObject({
    status: z.enum(ORDER_LIST_STATUSES).describe("Order status to list (Newegg requires one)."),
    keywordType: z
      .enum([
        "orderNumber",
        "invoiceNumber",
        "sellerPartNumber",
        "neweggItemNumber",
        "titleDescription",
        "manufacturer",
        "sellerOrderNumber",
      ])
      .optional()
      .describe(
        "What keywordValue is matched against (customer-name/phone search is not offered).",
      ),
    keywordValue: z.string().min(1).max(100).optional().describe("Search text for keywordType."),
    type: z
      .enum(["all", "sbn", "sbs", "multiChannel"])
      .optional()
      .describe("Fulfillment type filter (default all)."),
    dateFrom: reportDateSchema.optional().describe("Order date range start (Pacific Time)."),
    dateTo: reportDateSchema.optional().describe("Order date range end (Pacific Time)."),
    voidSoon: z
      .union([z.literal(24), z.literal(48)])
      .optional()
      .describe("Only orders that auto-void within this many hours."),
    includeDownloaded: z
      .boolean()
      .optional()
      .describe("false excludes already-downloaded orders (default includes them)."),
    countryCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional()
      .describe("Newegg.com only: 3-letter ISO ship-to country."),
    premierOrder: z
      .enum(["all", "premierOnly", "noPremier"])
      .optional()
      .describe("Newegg.com only: Premier order filter."),
    limit: limitSchema,
    waitSeconds: waitSecondsSchema,
  })
  .refine((input) => (input.keywordType === undefined) === (input.keywordValue === undefined), {
    message: "keywordType and keywordValue must be given together",
    path: ["keywordValue"],
  })
  .describe("Criteria for the Order List report.");

const orderListOutputSchema = reportOutputSchema.extend({
  currency: z.enum(["USD", "CAD"]).optional().describe("Currency of every amount."),
});

export const reportsOrderListTool: ToolDefinition<
  typeof orderListInputSchema,
  typeof orderListOutputSchema
> = {
  name: TOOL_NAMES.reportsOrderList,
  title: "Newegg order list report",
  description:
    "Order List report: orders of one status (required), optionally narrowed by keyword, " +
    "fulfillment type, order date range or void-soon window, with line items and packages. " +
    "Buyer data is NEVER returned (no names, addresses, phones or e-mails). Amounts are USD " +
    "(Newegg.com / Neweggbusiness.com) or CAD (Newegg.ca). Returns at most `limit` rows plus " +
    "totalRows. Waits up to waitSeconds; if still processing, returns pending=true with a " +
    "requestId for newegg_reports_status (reportType orderList). For one order prefer " +
    "newegg_orders_get. Read-only: creates a report job and changes nothing.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: orderListInputSchema,
  outputSchema: orderListOutputSchema,
  handler: (input, ctx) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    return runReport(ctx, async () => ({
      ...pagedOutput(
        await ctx.client.reports.orderList.waitForResult(
          {
            status: input.status,
            ...(input.keywordType !== undefined && input.keywordValue !== undefined
              ? { keyword: { type: input.keywordType, value: input.keywordValue } }
              : {}),
            ...(input.type !== undefined ? { type: input.type } : {}),
            ...(input.dateFrom !== undefined ? { dateFrom: input.dateFrom } : {}),
            ...(input.dateTo !== undefined ? { dateTo: input.dateTo } : {}),
            ...(input.voidSoon !== undefined ? { voidSoon: input.voidSoon } : {}),
            ...(input.includeDownloaded !== undefined
              ? { includeDownloaded: input.includeDownloaded }
              : {}),
            ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
            ...(input.premierOrder !== undefined ? { premierOrder: input.premierOrder } : {}),
          },
          waitOptions(input.waitSeconds, limit),
        ),
        limit,
        serializeOrderRow,
      ),
      currency: currencyOf(ctx.client),
    }));
  },
};

// ---------------------------------------------------------------------------
// newegg_reports_rma_list
// ---------------------------------------------------------------------------
const rmaListInputSchema = z
  .strictObject({
    keywordType: z
      .enum(["rmaNumber", "orderNumber", "sellerRmaNumber"])
      .optional()
      .describe("What keywordValue is matched against (customer-name search is not offered)."),
    keywordValue: z.string().min(1).max(100).optional().describe("Search text for keywordType."),
    status: z
      .enum(["open", "received", "rejected", "voided", "closed", "processing"])
      .optional()
      .describe("RMA status filter (default all)."),
    type: z.enum(["replacement", "refund"]).optional().describe("RMA kind filter (default all)."),
    processedBy: z
      .enum(["seller", "newegg"])
      .optional()
      .describe("Who processed the RMA (default all)."),
    dateFrom: reportDateSchema.optional().describe("RMA date range start (Pacific Time)."),
    dateTo: reportDateSchema.optional().describe("RMA date range end (Pacific Time)."),
    limit: limitSchema,
    waitSeconds: waitSecondsSchema,
  })
  .refine((input) => (input.keywordType === undefined) === (input.keywordValue === undefined), {
    message: "keywordType and keywordValue must be given together",
    path: ["keywordValue"],
  })
  .describe("Criteria for the RMA List report.");

export const reportsRmaListTool: ToolDefinition<
  typeof rmaListInputSchema,
  typeof orderListOutputSchema
> = {
  name: TOOL_NAMES.reportsRmaList,
  title: "Newegg RMA list report",
  description:
    "RMA List report: returns (replacements and refunds) filtered by status, kind, processor, " +
    "keyword or RMA date range, with per-SKU reason, quantity and refund amounts. Customer data " +
    "(name, phone, address, e-mail), RMA notes and return-label tracking are NEVER returned. " +
    "Amounts are USD (Newegg.com / Neweggbusiness.com) or CAD (Newegg.ca). Returns at most " +
    "`limit` rows plus totalRows. Waits up to waitSeconds; if still processing, returns " +
    "pending=true with a requestId for newegg_reports_status (reportType rmaList). For one RMA " +
    "prefer newegg_rma_get. Read-only: creates a report job and changes nothing.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: rmaListInputSchema,
  outputSchema: orderListOutputSchema,
  handler: (input, ctx) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    return runReport(ctx, async () => ({
      ...pagedOutput(
        await ctx.client.reports.rmaList.waitForResult(
          {
            ...(input.keywordType !== undefined && input.keywordValue !== undefined
              ? { keyword: { type: input.keywordType, value: input.keywordValue } }
              : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.type !== undefined ? { type: input.type } : {}),
            ...(input.processedBy !== undefined ? { processedBy: input.processedBy } : {}),
            ...(input.dateFrom !== undefined ? { dateFrom: input.dateFrom } : {}),
            ...(input.dateTo !== undefined ? { dateTo: input.dateTo } : {}),
          },
          waitOptions(input.waitSeconds, limit),
        ),
        limit,
        serializeRma,
      ),
      currency: currencyOf(ctx.client),
    }));
  },
};

// ---------------------------------------------------------------------------
// newegg_reports_status
// ---------------------------------------------------------------------------
const REPORT_TYPES = [
  "settlementSummary",
  "settlementTransactions",
  "dailyInventory",
  "dailyPrice",
  "itemBasicInfo",
  "orderList",
  "rmaList",
] as const;

const statusInputSchema = z
  .strictObject({
    requestId: z
      .string()
      .min(1)
      .max(64)
      .describe("The requestId returned (pending) by a newegg_reports_* tool."),
    reportType: z.enum(REPORT_TYPES).describe("Which report the requestId belongs to."),
    limit: limitSchema,
  })
  .describe("A pending report to check.");

const statusOutputSchema = z.object({
  marketplace: marketplaceSchema,
  requestId: z.string(),
  status: z.enum(["submitted", "inProgress", "finished", "cancelled", "unknown"]),
  rows: z.array(rowSchema).optional(),
  totalRows: z.number().optional(),
  returnedRows: z.number().optional(),
  truncated: z.boolean().optional(),
  fileName: z.string().optional(),
  currency: z.enum(["USD", "CAD"]).optional(),
});

async function collectFinished(
  client: NeweggClient,
  input: z.infer<typeof statusInputSchema>,
  limit: number,
): Promise<Record<string, unknown>> {
  const options = waitOptions(5, limit);
  switch (input.reportType) {
    case "settlementSummary":
      return pagedOutput(
        await client.reports.settlementSummary.waitForRequest(input.requestId, options),
        limit,
      );
    case "settlementTransactions":
      return pagedOutput(
        await client.reports.settlementTransactions.waitForRequest(input.requestId, options),
        limit,
      );
    case "dailyInventory":
      return fileOutput(
        await client.reports.dailyInventory.waitForRequest(input.requestId, options),
        limit,
      );
    case "dailyPrice":
      return fileOutput(
        await client.reports.dailyPrice.waitForRequest(input.requestId, options),
        limit,
      );
    case "itemBasicInfo":
      return fileOutput(
        await client.reports.itemBasicInfo.waitForRequest(input.requestId, options),
        limit,
        serializeItemRow,
      );
    case "orderList":
      return {
        ...pagedOutput(
          await client.reports.orderList.waitForRequest(input.requestId, options),
          limit,
          serializeOrderRow,
        ),
        currency: currencyOf(client),
      };
    case "rmaList":
      return {
        ...pagedOutput(
          await client.reports.rmaList.waitForRequest(input.requestId, options),
          limit,
          serializeRma,
        ),
        currency: currencyOf(client),
      };
  }
}

async function statusHandler(
  input: z.infer<typeof statusInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const status = await ctx.client.reports.status(input.requestId);
    if (status.status !== "finished") {
      return okResult({
        marketplace: status.marketplace,
        requestId: status.requestId,
        status: status.status,
      });
    }
    const output = await collectFinished(ctx.client, input, input.limit ?? DEFAULT_LIMIT);
    const { pending: _pending, ...rest } = output;
    return okResult({ ...rest, status: "finished" });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const reportsStatusTool: ToolDefinition<
  typeof statusInputSchema,
  typeof statusOutputSchema
> = {
  name: TOOL_NAMES.reportsStatus,
  title: "Check a pending Newegg report",
  description:
    "Check a pending report started by a newegg_reports_* tool (pass its requestId and the same " +
    "reportType). When finished, returns the report rows (up to `limit`, plus totalRows); " +
    "otherwise returns the current status - wait a few seconds and call again. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: statusInputSchema,
  outputSchema: statusOutputSchema,
  handler: statusHandler,
};
