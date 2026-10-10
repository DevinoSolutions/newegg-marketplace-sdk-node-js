/**
 * `newegg_pricing_apply_update` - the mutating second half of the ADR 0005 price-write flow. It
 * accepts ONLY a previewId (prices can never be supplied here), atomically consumes the stored
 * preview (single use; replay and expiry rejected distinctly), and executes exactly the stored
 * eligible updates through the SDK's `pricing.update`, reading every price back to verify it.
 * The preview is consumed once even if the downstream call fails. Registered only when writes
 * are enabled.
 */
import { z } from "zod";
import {
  errorResult,
  mapErrorToPayload,
  okResult,
  serializeRateLimit,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./shared.js";
import { appendConsumedNote, consumeTypedPreview } from "./preview-apply-core.js";
import { identifierOutput, pricingOperationResultSchema } from "./pricing-result.js";
import { TOOL_NAMES } from "./names.js";

const applyInputSchema = z
  .strictObject({
    previewId: z
      .string()
      .min(1)
      .describe("The single-use previewId returned by newegg_pricing_preview_update."),
  })
  .describe("The previewId to apply. Prices cannot be supplied here.");

async function handler(
  input: z.infer<typeof applyInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const outcome = await consumeTypedPreview(ctx, input.previewId, "priceUpdate");
  if ("error" in outcome) {
    return outcome.error;
  }

  const record = outcome.record;
  try {
    // Exactly the stored, normalized updates; the SDK re-validates them and reads each price
    // back (verify defaults to true).
    const result = await ctx.client.pricing.update(record.normalizedUpdates, { verify: true });

    return okResult({
      operationId: result.operationId,
      correlationId: result.correlationId,
      marketplace: result.marketplace,
      mode: "apply",
      submittedItemCount: result.submittedItemCount,
      appliedItemCount: result.appliedItemCount,
      failedItemCount: result.failedItemCount,
      unresolvedItemCount: result.unresolvedItemCount,
      blockedItemCount: 0,
      deduplicatedItemCount: result.deduplicatedItemCount,
      previewId: record.previewId,
      items: result.items.map((item) => ({
        inputIndex: item.inputIndex,
        identifier: identifierOutput(item.identifier),
        countryCode: item.countryCode,
        newSellingPrice: item.requestedSellingPrice,
        observedSellingPrice: item.observedSellingPrice,
        status: item.status,
        errorCode: item.errorCode,
        message: item.message,
      })),
      warnings: result.warnings,
      rateLimit: serializeRateLimit(result.rateLimit),
    });
  } catch (error) {
    return errorResult(appendConsumedNote(mapErrorToPayload(error, ctx.logger)));
  }
}

export const pricingApplyTool: ToolDefinition<
  typeof applyInputSchema,
  typeof pricingOperationResultSchema
> = {
  name: TOOL_NAMES.pricingApplyUpdate,
  title: "Apply a previewed selling-price update",
  description:
    "Execute exactly the selling-price update captured by a previewId from " +
    "newegg_pricing_preview_update. Accepts only the previewId - prices cannot be changed at " +
    "apply time. The preview is single-use and consumed atomically (replays and expired " +
    "previews are rejected). Each price is read back after the write: verified = the new price " +
    "is live; unverified/unknown = re-read it with newegg_pricing_get before trusting or " +
    "retrying (Newegg silently ignores price updates to deactivated items). This tool exists " +
    "only when the server is started with writes enabled.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: applyInputSchema,
  outputSchema: pricingOperationResultSchema,
  handler,
};
