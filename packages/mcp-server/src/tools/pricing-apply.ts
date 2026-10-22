/**
 * `newegg_pricing_apply_update` - the mutating second half of the ADR 0005 price-write flow. It
 * accepts ONLY a previewId (prices can never be supplied here), atomically consumes the stored
 * preview (single use; replay and expiry rejected distinctly), and executes exactly the stored
 * eligible updates through the SDK's `pricing.update`, reading every price back to verify it.
 * Just before sending, every item's live price is re-read (reads only) and the percent cap and
 * MSRP/currency blockers are re-run against it; the apply is refused with `preview_stale` (nothing
 * sent) when any blocker trips or a live price differs from the one the preview was assessed
 * against (T-6219). The preview is consumed once even if the downstream call fails. Registered only when writes
 * are enabled.
 */
import { z } from "zod";
import {
  businessError,
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
import { enforceChangeLimit, previewedPrice, priceDrifted } from "./pricing-guards.js";

const formatPrice = (price: number | null): string =>
  price === null ? "unknown" : price.toFixed(2);

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

  // Re-assess against the LIVE prices (reads only): the percent cap and MSRP / currency blockers
  // were computed at preview time against a price that may have moved since. Any blocker, or any
  // difference between the live and the previewed price, aborts before a single write.
  const problems: string[] = [];
  try {
    const fresh = await ctx.client.pricing.previewUpdate(record.normalizedUpdates, {
      includeCurrentPrice: true,
    });
    if (fresh.changes.length !== record.normalizedUpdates.length) {
      problems.push("The set of updates could not be re-assessed.");
    }
    fresh.changes.forEach((change, position) => {
      enforceChangeLimit(change, ctx.config.limits.maxPriceChangePercent);
      const label = `Update ${record.normalizedUpdates[position]?.inputIndex ?? position}`;
      for (const blocker of change.blockers) problems.push(`${label}: ${blocker}`);
      const previewed = record.previewedCurrentPrices[position] ?? null;
      const observed = previewedPrice(change);
      if (priceDrifted(previewed, observed)) {
        problems.push(
          `${label}: the current selling price changed since the preview (previewed ` +
            `${formatPrice(previewed)}, now ${formatPrice(observed)}).`,
        );
      }
    });
  } catch (error) {
    return errorResult(appendConsumedNote(mapErrorToPayload(error, ctx.logger)));
  }
  if (problems.length > 0) {
    return errorResult(
      businessError(
        "preview_stale",
        `Nothing was sent: ${problems.join(" ")} The preview has been consumed; create a new preview and review it.`,
      ),
    );
  }

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
    "previews are rejected). Before writing, apply re-reads every live price and refuses with " +
    "preview_stale (nothing sent) when one differs from the price the preview was assessed " +
    "against, or when a change now breaks a price cap. Each price is read back after the write: verified = the new price " +
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
