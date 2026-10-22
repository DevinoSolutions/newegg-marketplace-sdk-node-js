import { z } from "zod";
import { serializeRma } from "../rma.js";
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
