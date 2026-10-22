import { z } from "zod";
import type { Order } from "@devino/newegg-marketplace-sdk";
import { type ToolDefinition } from "../shared.js";
import { TOOL_NAMES } from "../names.js";
import {
  currencyOf,
  DEFAULT_LIMIT,
  limitSchema,
  orderListOutputSchema,
  pagedOutput,
  reportDateSchema,
  runReport,
  waitOptions,
  waitSecondsSchema,
} from "./common.js";

// ---------------------------------------------------------------------------
// newegg_reports_order_list
// ---------------------------------------------------------------------------

/**
 * PII-free order row. The customer block (name, phone, masked e-mail, ship-to address) and the
 * free-text package memo are NEVER mapped; everything else is business data.
 */
export function serializeOrderRow(order: Order): Record<string, unknown> {
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
