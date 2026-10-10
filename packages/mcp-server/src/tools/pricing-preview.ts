/**
 * `newegg_pricing_preview_update` - the read-only first half of the ADR 0005 price-write flow.
 * It validates and risk-checks selling-price updates through the SDK's `pricing.previewUpdate`
 * (which only READS current prices), enforces the server-side fat-finger guard
 * (`NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT`), and stores ONLY the eligible updates under a
 * cryptographically random previewId. Blocked updates (unknown item, currency mismatch, price
 * above MSRP, over the change limit, unreadable current price) are reported and never stored,
 * so `newegg_pricing_apply_update` cannot apply them. Registered only when writes are enabled.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PriceChange, PriceUpdate } from "@devino/newegg-marketplace-sdk";
import type { McpServerConfig } from "../config/index.js";
import type { PricePreviewRecord } from "../preview-store/index.js";
import {
  errorResult,
  identifierInputSchema,
  mapErrorToPayload,
  okResult,
  toItemIdentifier,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./shared.js";
import { identifierOutput, pricingOperationResultSchema } from "./pricing-result.js";
import { TOOL_NAMES } from "./names.js";

/** SDK per-call ceiling for price updates (one request each). */
const SDK_MAX_PRICE_UPDATES = 100;

const updateSchema = z
  .strictObject({
    identifier: identifierInputSchema,
    sellingPrice: z
      .number()
      .gt(0)
      .max(99999.99)
      .describe("The NEW selling price (absolute, > 0, at most 2 decimals, <= 99999.99)."),
    countryCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional()
      .describe("US marketplace only (required there): uppercase ISO alpha-3 country, e.g. USA."),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional()
      .describe("US marketplace only (required there): ISO 4217 code matching the country."),
  })
  .describe("A single selling-price assignment (price only - MAP/MSRP/shipping are untouched).");

function makeInputSchema(maxItems: number) {
  const max = Math.min(maxItems, SDK_MAX_PRICE_UPDATES);
  return z
    .strictObject({
      updates: z
        .array(updateSchema)
        .min(1)
        .max(max)
        .describe(`1-${max} selling-price updates to plan.`),
    })
    .describe("Selling-price updates to validate and plan (no writes happen here).");
}

type PreviewInputSchema = ReturnType<typeof makeInputSchema>;
type PreviewInput = z.infer<PreviewInputSchema>;

function hashPayload(marketplace: string, updates: PriceUpdateWithIndex[]): string {
  const canonical = JSON.stringify({
    marketplace,
    updates: updates.map((update) => ({
      inputIndex: update.inputIndex,
      type: update.identifier.type,
      value: update.identifier.value,
      condition: update.identifier.type === "upc" ? (update.identifier.condition ?? null) : null,
      sellingPrice: update.sellingPrice,
      countryCode: update.countryCode ?? null,
      currency: update.currency ?? null,
    })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

type PriceUpdateWithIndex = PriceUpdate & { inputIndex: number };

function itemOutput(change: PriceChange) {
  return {
    inputIndex: change.inputIndex,
    identifier: identifierOutput(change.identifier),
    countryCode: change.countryCode,
    currency: change.currency,
    newSellingPrice: change.newSellingPrice,
    currentSellingPrice: change.currentSellingPrice,
    changePercent: change.changePercent,
    status: change.status === "unchecked" ? ("warning" as const) : change.status,
    blockers: change.blockers,
    warnings: change.warnings,
  };
}

async function handler(input: PreviewInput, ctx: ToolContext): Promise<ToolResult> {
  const { limits } = ctx.config;
  const updates: PriceUpdate[] = input.updates.map((update) => {
    const mapped: PriceUpdate = {
      identifier: toItemIdentifier(update.identifier),
      sellingPrice: update.sellingPrice,
    };
    if (update.countryCode !== undefined) mapped.countryCode = update.countryCode;
    if (update.currency !== undefined) mapped.currency = update.currency;
    return mapped;
  });

  let preview;
  try {
    // Always reads current prices (zero writes): the checks below depend on them.
    preview = await ctx.client.pricing.previewUpdate(updates, { includeCurrentPrice: true });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }

  // Server-side policy, enforced in code (not in descriptions): the fat-finger change limit.
  for (const change of preview.changes) {
    if (
      change.changePercent !== undefined &&
      Math.abs(change.changePercent) > limits.maxPriceChangePercent
    ) {
      change.blockers.push(
        `The change of ${change.changePercent}% exceeds the server limit of ` +
          `${limits.maxPriceChangePercent}% (NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT).`,
      );
      change.status = "blocked";
    }
  }

  const eligible = preview.normalizedUpdates.filter((update) => {
    const change = preview.changes.find((candidate) => candidate.inputIndex === update.inputIndex);
    return change !== undefined && change.status !== "blocked";
  });
  const blockedItemCount = preview.changes.length - eligible.length;

  const deduplicatedItemCount = preview.deduplicated.reduce(
    (total, entry) => total + entry.droppedInputIndexes.length,
    0,
  );
  const warnings = [...preview.warnings];
  if (blockedItemCount > 0 && eligible.length > 0) {
    warnings.push("Blocked updates are NOT included in the previewId and cannot be applied.");
  }

  let previewId: string | undefined;
  let previewExpiresAt: string | undefined;
  if (eligible.length > 0) {
    const createdAt = ctx.now();
    const expiresAt = new Date(createdAt.getTime() + limits.previewTtlSeconds * 1000);
    previewId = randomBytes(32).toString("base64url");
    previewExpiresAt = expiresAt.toISOString();
    const record: PricePreviewRecord = {
      previewId,
      kind: "priceUpdate",
      hash: hashPayload(preview.marketplace, eligible),
      marketplace: preview.marketplace,
      normalizedUpdates: eligible,
      createdAt,
      expiresAt,
    };
    await ctx.previewStore.put(record);
  } else {
    warnings.push("Nothing is eligible to apply, so no previewId was issued.");
  }

  return okResult({
    operationId: randomUUID(),
    correlationId: preview.correlationId,
    marketplace: preview.marketplace,
    mode: "preview",
    submittedItemCount: eligible.length,
    appliedItemCount: 0,
    failedItemCount: 0,
    unresolvedItemCount: 0,
    blockedItemCount,
    deduplicatedItemCount,
    previewId,
    previewExpiresAt,
    items: preview.changes.map(itemOutput),
    warnings,
  });
}

export function createPricingPreviewTool(
  config: McpServerConfig,
): ToolDefinition<PreviewInputSchema, typeof pricingOperationResultSchema> {
  return {
    name: TOOL_NAMES.pricingPreviewUpdate,
    title: "Preview a selling-price update",
    description:
      "Validate and risk-check Newegg selling-price updates WITHOUT changing anything. Reads each " +
      "item's current price and reports the change percent, plus BLOCKERS (unknown item, currency " +
      "mismatch, price above MSRP, change larger than the server limit of " +
      `${config.limits.maxPriceChangePercent}%) and WARNINGS (inactive item - Newegg ignores its ` +
      "price updates while reporting success; promotion lock; below MAP; no-op). Only eligible " +
      "(non-blocked) updates get a single-use previewId that newegg_pricing_apply_update " +
      "executes exactly. Only the selling price is ever set - never MAP, MSRP, shipping or " +
      "activation. US updates need countryCode and currency. No Newegg mutation happens here.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: makeInputSchema(config.limits.maxItemsPerOperation),
    outputSchema: pricingOperationResultSchema,
    handler,
  };
}
