/**
 * `newegg_inventory_apply_update` — the mutating second half of the ADR 0005 write flow. It
 * accepts ONLY a previewId (quantities can never be supplied here), atomically consumes the
 * stored preview (single use; replay and expiry rejected distinctly), and executes exactly the
 * stored normalized operation. The preview is consumed exactly once even if the downstream call
 * fails. This tool is registered only when writes are enabled.
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
import { inventoryOperationResultSchema, mapFeedJob, mapItemOutcome } from "./operation-result.js";
import { TOOL_NAMES } from "./names.js";

const applyInputSchema = z
  .strictObject({
    previewId: z
      .string()
      .min(1)
      .describe("The single-use previewId returned by newegg_inventory_preview_update."),
  })
  .describe("The previewId to apply. Quantities cannot be supplied here.");

async function handler(
  input: z.infer<typeof applyInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const outcome = await consumeTypedPreview(ctx, input.previewId, "inventoryUpdate");
  if ("error" in outcome) {
    return outcome.error;
  }

  const record = outcome.record;
  try {
    // Execute exactly the stored, normalized operation. The SDK tolerates the normalized
    // shape (it round-trips `previewUpdate` output back through `updateMany`).
    const result = await ctx.client.inventory.updateMany(record.normalizedUpdates, {
      strategy: record.strategy,
      waitForFeedCompletion: false,
    });

    const warnings = [...result.warnings];
    const feedJobs = result.feedJobs?.map(mapFeedJob);
    if (feedJobs !== undefined && feedJobs.length > 0) {
      warnings.push(
        "Feed submission accepted; processing is asynchronous. Poll newegg_feed_status with the " +
          "requestId(s) and fetch newegg_feed_result once FINISHED.",
      );
    }

    return okResult({
      operationId: result.operationId,
      correlationId: result.correlationId,
      marketplace: result.marketplace,
      mode: "apply",
      strategy: result.strategy,
      submittedItemCount: result.submittedItemCount,
      acceptedItemCount: result.acceptedItemCount,
      failedItemCount: result.failedItemCount,
      deduplicatedItemCount: result.deduplicatedItemCount,
      previewId: record.previewId,
      feedJobs,
      items: result.items.map(mapItemOutcome),
      warnings,
      rateLimit: serializeRateLimit(result.rateLimit),
    });
  } catch (error) {
    return errorResult(appendConsumedNote(mapErrorToPayload(error, ctx.logger)));
  }
}

export const inventoryApplyTool: ToolDefinition<
  typeof applyInputSchema,
  typeof inventoryOperationResultSchema
> = {
  name: TOOL_NAMES.inventoryApplyUpdate,
  title: "Apply a previewed inventory update",
  description:
    "Execute exactly the inventory update captured by a previewId from " +
    "newegg_inventory_preview_update. Accepts only the previewId — quantities cannot be changed " +
    "at apply time. The preview is single-use and consumed atomically (replays and expired " +
    "previews are rejected). Direct submissions return final per-item statuses; feed submissions " +
    "return feed jobs to poll with newegg_feed_status / newegg_feed_result. This tool exists only " +
    "when the server is started with writes enabled.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: applyInputSchema,
  outputSchema: inventoryOperationResultSchema,
  handler,
};
