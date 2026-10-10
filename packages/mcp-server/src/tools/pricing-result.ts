/**
 * The shared `PricingOperationResult` output schema returned by both the price preview and
 * apply tools. Every field is JSON-primitive so the structured output and its text fallback are
 * byte-identical after JSON serialization.
 */
import { z } from "zod";
import type { ItemIdentifier } from "@devino/newegg-marketplace-sdk";
import {
  conditionOf,
  identifierOutputSchema,
  marketplaceSchema,
  rateLimitOutputSchema,
} from "./shared.js";

/** Preview statuses (`ok` | `warning` | `blocked`) and apply statuses (the rest). */
const pricingItemStatusSchema = z.enum([
  "ok",
  "warning",
  "blocked",
  "verified",
  "accepted",
  "unverified",
  "unknown",
  "failed",
]);

const pricingItemSchema = z.object({
  inputIndex: z.number().int(),
  identifier: identifierOutputSchema,
  countryCode: z.string().optional(),
  currency: z.string().optional(),
  /** The price being assigned. */
  newSellingPrice: z.number(),
  currentSellingPrice: z.number().optional(),
  changePercent: z.number().optional(),
  /** Apply only: what the read-back (or the write response) reported. */
  observedSellingPrice: z.number().optional(),
  status: pricingItemStatusSchema,
  errorCode: z.string().optional(),
  message: z.string().optional(),
  blockers: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});

export const pricingOperationResultSchema = z.object({
  operationId: z.string(),
  correlationId: z.string(),
  marketplace: marketplaceSchema,
  mode: z.enum(["preview", "apply"]),
  /** Preview: updates eligible to apply. Apply: updates sent to Newegg. */
  submittedItemCount: z.number().int(),
  appliedItemCount: z.number().int(),
  failedItemCount: z.number().int(),
  /** Apply: `unverified` + `unknown` - re-read these before trusting or retrying. */
  unresolvedItemCount: z.number().int(),
  /** Preview: updates that must NOT be applied. */
  blockedItemCount: z.number().int(),
  deduplicatedItemCount: z.number().int(),
  previewId: z.string().optional(),
  previewExpiresAt: z.string().optional(),
  items: z.array(pricingItemSchema),
  warnings: z.array(z.string()),
  rateLimit: rateLimitOutputSchema.optional(),
});

/** Serializes an identifier for output (condition only for UPC). */
export function identifierOutput(
  identifier: ItemIdentifier,
): z.infer<typeof identifierOutputSchema> {
  return {
    type: identifier.type,
    value: identifier.value,
    condition: conditionOf(identifier),
  };
}
