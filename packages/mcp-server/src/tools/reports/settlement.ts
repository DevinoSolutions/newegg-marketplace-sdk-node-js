import { z } from "zod";
import { type ToolDefinition } from "../shared.js";
import { TOOL_NAMES } from "../names.js";
import {
  DEFAULT_LIMIT,
  limitSchema,
  pagedOutput,
  reportDateSchema,
  reportOutputSchema,
  runReport,
  waitOptions,
  waitSecondsSchema,
} from "./common.js";

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
