/**
 * Courtesy refund WRITE tools (contracts §20.5): `newegg_refund_preview_issue` (read-only plan) and
 * `newegg_refund_apply_issue` (pays the customer). Both are registered only when
 * `NEWEGG_MCP_ALLOW_WRITES=true`; apply accepts only a previewId. The refund ceiling
 * `NEWEGG_MCP_MAX_REFUND_AMOUNT` is enforced at preview time in code.
 */
import { z } from "zod";
import type { McpServerConfig } from "../config/index.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./shared.js";
import { serializeRateLimit } from "./shared.js";
import {
  numberInputSchema,
  runServiceApply,
  runServicePreview,
  serviceApplyOutputSchema,
  servicePreviewOutputSchema,
} from "./service-write.js";
import { TOOL_NAMES } from "./names.js";

const issueInputSchema = z
  .strictObject({
    orderNumber: numberInputSchema.describe("The Newegg order to refund."),
    reason: z
      .enum([
        "negativeCustomerFeedback",
        "pricingError",
        "wrongItemInformation",
        "shippingDelay",
        "packageNotReceived",
        "customerCourtesy",
      ])
      .describe("Why the courtesy refund is issued."),
    amount: z
      .number()
      .gt(0)
      .max(99999.99)
      .describe("Total refund in the marketplace currency: > 0, at most 2 decimals."),
    noteToCustomer: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Note shown to the customer, <= 500."),
  })
  .describe("The courtesy refund to plan.");

const MONEY_WARNING =
  "WARNING: this pays the customer, the commission is NOT refunded, and the call is not idempotent; " +
  "only apply after a human has read the preview.";

export function createRefundPreviewIssueTool(
  config: McpServerConfig,
): ToolDefinition<typeof issueInputSchema, typeof servicePreviewOutputSchema> {
  return {
    name: TOOL_NAMES.refundPreviewIssue,
    title: "Preview a courtesy refund",
    description:
      "Plan a Newegg Issue Courtesy Refund WITHOUT changing anything. Reads the order, its RMAs and its " +
      "courtesy refunds and reports BLOCKERS (unknown/voided/unshipped/replacement order, refund above the " +
      "order total or the total minus prior refunds, refund above the server limit of " +
      `${config.limits.maxRefundAmount}) and WARNINGS (duplicates). Only a clean plan gets a single-use ` +
      `previewId for newegg_refund_apply_issue. ${MONEY_WARNING} No Newegg mutation happens here.`,
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: issueInputSchema,
    outputSchema: servicePreviewOutputSchema,
    handler: (input: z.infer<typeof issueInputSchema>, ctx: ToolContext): Promise<ToolResult> =>
      runServicePreview(ctx, "courtesyRefundIssue", () => ctx.client.refunds.previewIssue(input)),
  };
}

const applyInputSchema = z
  .strictObject({
    previewId: z
      .string()
      .min(1)
      .describe(`The single-use previewId returned by ${TOOL_NAMES.refundPreviewIssue}.`),
  })
  .describe("The previewId to apply. Nothing else can be supplied here.");

export const refundApplyIssueTool: ToolDefinition<
  typeof applyInputSchema,
  typeof serviceApplyOutputSchema
> = {
  name: TOOL_NAMES.refundApplyIssue,
  title: "Apply a previewed courtesy refund",
  description:
    "Issue EXACTLY the courtesy refund captured by a previewId from newegg_refund_preview_issue. The " +
    "refund is asynchronous: follow the returned requestId with newegg_refund_status. Accepts only the " +
    "previewId; single-use. If the outcome is unknown (timeout, 5xx) the error says so and the write is " +
    `NOT retried: check newegg_refund_list and newegg_refund_status first. ${MONEY_WARNING} ` +
    "Exists only when the server is started with writes enabled.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: applyInputSchema,
  outputSchema: serviceApplyOutputSchema,
  handler: (input, ctx) =>
    runServiceApply(ctx, "courtesyRefundIssue", input.previewId, async (stored) => {
      const result = await ctx.client.refunds.issue(stored);
      return {
        correlationId: result.correlationId,
        marketplace: result.marketplace,
        operation: "refunds.issue",
        currency: result.currency,
        courtesyRefund: {
          requestId: result.requestId,
          state: result.state,
          stateRaw: result.stateRaw,
          requestDate: result.requestDate?.iso ?? result.requestDate?.raw,
          orderNumber: result.orderNumber,
          amount: result.amount,
        },
        rateLimit: serializeRateLimit(result.rateLimit),
      };
    }),
};
