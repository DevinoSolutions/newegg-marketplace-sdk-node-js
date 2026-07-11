/**
 * The shared `InventoryOperationResult` output schema returned by both the preview and apply
 * inventory tools, plus small mappers from SDK result types. Reset instants and any Date are
 * excluded here — every field is JSON-primitive so the structured output and its text fallback
 * are byte-identical after JSON serialization.
 */
import { z } from "zod";
import type { FeedJobSummary, ItemOutcome } from "@devino/newegg-marketplace-sdk";
import { marketplaceSchema, rateLimitOutputSchema } from "./shared.js";

export const itemOutcomeStatusSchema = z.enum([
  "planned",
  "submitted",
  "succeeded",
  "warning",
  "failed",
  "unknown",
]);

export const feedRequestStatusSchema = z.enum([
  "SUBMITTED",
  "IN_PROGRESS",
  "FINISHED",
  "CANCELLED",
  "UNKNOWN",
]);

export const operationItemSchema = z.object({
  inputIndex: z.number().int(),
  sellerPartNumber: z.string().optional(),
  warehouseLocation: z.string().optional(),
  quantity: z.number().int(),
  status: itemOutcomeStatusSchema,
  errorCode: z.string().optional(),
  message: z.string().optional(),
});

export const feedJobSchema = z.object({
  requestId: z.string(),
  status: feedRequestStatusSchema,
  itemCount: z.number().int(),
});

export const inventoryOperationResultSchema = z.object({
  operationId: z.string(),
  correlationId: z.string(),
  marketplace: marketplaceSchema,
  mode: z.enum(["preview", "apply"]),
  strategy: z.enum(["direct", "feed", "mixed"]),
  submittedItemCount: z.number().int(),
  acceptedItemCount: z.number().int(),
  failedItemCount: z.number().int(),
  deduplicatedItemCount: z.number().int(),
  previewId: z.string().optional(),
  previewExpiresAt: z.string().optional(),
  feedJobs: z.array(feedJobSchema).optional(),
  items: z.array(operationItemSchema),
  warnings: z.array(z.string()),
  rateLimit: rateLimitOutputSchema.optional(),
});

/** Maps an SDK `ItemOutcome` to the tool output item shape (undefined keys pruned downstream). */
export function mapItemOutcome(outcome: ItemOutcome): Record<string, unknown> {
  return {
    inputIndex: outcome.inputIndex,
    sellerPartNumber: outcome.sellerPartNumber,
    warehouseLocation: outcome.warehouseLocation,
    quantity: outcome.quantity,
    status: outcome.status,
    errorCode: outcome.errorCode,
    message: outcome.message,
  };
}

/** Maps an SDK `FeedJobSummary` to the tool output feed-job shape. */
export function mapFeedJob(job: FeedJobSummary): Record<string, unknown> {
  return { requestId: job.requestId, status: job.status, itemCount: job.itemCount };
}
