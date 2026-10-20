/**
 * Shipping Label WRITE tools (contracts §23): `newegg_shipping_label_preview_create` /
 * `newegg_shipping_label_apply_create` (BUYS a UPS label, bills the seller's Newegg account and
 * ships the order) and `newegg_shipping_label_preview_reprint` / `newegg_shipping_label_apply_reprint`
 * (re-issues a label; billing unknown, treated as billable). All four are registered only when
 * `NEWEGG_MCP_ALLOW_WRITES=true`; apply accepts only a previewId (ADR 0005).
 *
 * The label download links Newegg returns are bearer links: they are surfaced only when they point
 * at a `*.newegg.com` https host, and customer data (the ship-to address) is never returned.
 * By default there is no server-side cost ceiling and a human must read the preview before applying.
 * `NEWEGG_MCP_MAX_LABEL_AMOUNT` is an opt-in ceiling: when it is set, the create preview carries
 * Newegg's quote and is blocked above the cap (re-checked at apply), and any cost that cannot be
 * determined (a failed quote, an unrated package, or a reprint, which has no quote) is blocked too.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { IndeterminateOrderWriteError } from "@devino/newegg-marketplace-sdk";
import type {
  ShippingLabelEstimate,
  ShippingLabelInput,
  ShippingLabelPackageResult,
  ShippingLabelPreview,
} from "@devino/newegg-marketplace-sdk";
import type {
  ShippingLabelInputs,
  ShippingLabelKind,
  ShippingLabelPreviewRecord,
} from "../preview-store/index.js";
import {
  businessError,
  errorResult,
  mapErrorToPayload,
  marketplaceSchema,
  okResult,
  rateLimitOutputSchema,
  serializeRateLimit,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./shared.js";
import { numberInputSchema } from "./service-write.js";
import { shippingLabelRequestSchema } from "./shipping-label.js";
import { appendConsumedNote, consumeTypedPreview } from "./preview-apply-core.js";
import { TOOL_NAMES } from "./names.js";

const operationSchema = z.enum(["shippingLabels.create", "shippingLabels.reprint"]);

const previewOutputSchema = z.object({
  operationId: z.string(),
  correlationId: z.string(),
  marketplace: marketplaceSchema,
  mode: z.literal("preview"),
  operation: operationSchema,
  currency: z.enum(["USD", "CAD"]),
  orderNumber: z.string(),
  /** True when nothing blocks the write; only then is a previewId issued. */
  eligible: z.boolean(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  /** The exact normalized request the apply tool will send. */
  request: z.record(z.string(), z.unknown()),
  /** Newegg's quote for the label(s), present only when NEWEGG_MCP_MAX_LABEL_AMOUNT is set. */
  estimatedCost: z.number().optional(),
  /** The configured NEWEGG_MCP_MAX_LABEL_AMOUNT, present only when it is set. */
  maxLabelAmount: z.number().optional(),
  previewId: z.string().optional(),
  previewExpiresAt: z.string().optional(),
});

const timestampSchema = z.object({ raw: z.string(), iso: z.string().optional() });

const applyOutputSchema = z.object({
  operationId: z.string(),
  correlationId: z.string(),
  marketplace: marketplaceSchema,
  mode: z.literal("apply"),
  operation: operationSchema,
  previewId: z.string(),
  orderNumber: z.string(),
  currency: z.enum(["USD", "CAD"]).optional(),
  shipDate: timestampSchema.optional(),
  orderStatus: z.string().optional(),
  packages: z.array(
    z.object({
      succeeded: z.boolean(),
      errorMessage: z.string().optional(),
      trackingNumber: z.string().optional(),
      signatureRequired: z.boolean(),
      /** Present only for an https `*.newegg.com` link. */
      labelUrl: z.string().optional(),
      packingListUrl: z.string().optional(),
      /** True when Newegg returned a link that was not an https `*.newegg.com` URL and was dropped. */
      urlWithheld: z.boolean(),
      rate: z
        .object({
          shipWeight: z.number().optional(),
          arriveBy: timestampSchema.optional(),
          shippingAmount: z.number().optional(),
          signatureAmount: z.number().optional(),
          total: z.number().optional(),
        })
        .optional(),
      items: z.array(z.object({ sellerPartNumber: z.string(), quantity: z.number() })),
    }),
  ),
  succeededCount: z.number(),
  failedCount: z.number(),
  /** Sum of the billed totals of the successful packages (create only). */
  totalCharged: z.number().optional(),
  rateLimit: rateLimitOutputSchema.optional(),
});

const COST_WARNING =
  "WARNING: creating a label spends money (UPS charge billed to the seller's Newegg account), marks " +
  "the order shipped and cannot be undone through this server; the call is not idempotent. Only " +
  "apply after a human has read the preview. When NEWEGG_MCP_MAX_LABEL_AMOUNT is set the preview " +
  "carries the quoted cost and is blocked above that cap.";

const toCents = (amount: number): number => Math.round(amount * 100);

function hashInput(
  kind: ShippingLabelKind,
  marketplace: string,
  input: unknown,
  costCents: number | undefined,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind, marketplace, input, costCents: costCents ?? null }), "utf8")
    .digest("hex");
}

/** The cost of a label, or the reason it could not be determined. */
type LabelCost = { total: number; currency: string } | { problem: string };

/** A reprint has no quote: Newegg's reprint request carries only the order number. */
const REPRINT_UNQUOTABLE =
  "The cost of a reprint cannot be determined (Newegg has no quote for it and does not say whether " +
  "it is billed), so it cannot be checked against NEWEGG_MCP_MAX_LABEL_AMOUNT. Unset the cap to " +
  "reprint after a human review.";

/**
 * Quotes a label purchase through the SDK estimate. Never throws and fails closed: a failed quote,
 * a package Newegg did not rate, or a total that does not read as positive money is a problem, not
 * a zero.
 */
async function quoteCreateCost(ctx: ToolContext, input: ShippingLabelInput): Promise<LabelCost> {
  let estimate: ShippingLabelEstimate;
  try {
    estimate = await ctx.client.shippingLabels.estimate(input);
  } catch (error) {
    const reason = mapErrorToPayload(error, ctx.logger).message;
    return {
      problem:
        `The label cost could not be quoted (${reason}), so it cannot be checked against ` +
        "NEWEGG_MCP_MAX_LABEL_AMOUNT.",
    };
  }
  // A quote for fewer packages than the purchase would undercount the cost.
  if (estimate.packages.length !== input.packages.length) {
    return {
      problem:
        "Newegg quoted a different number of packages than the purchase would create, so the " +
        "label cost cannot be checked against NEWEGG_MCP_MAX_LABEL_AMOUNT.",
    };
  }
  let total = 0;
  for (const pkg of estimate.packages) {
    const packageTotal = pkg.rate?.total;
    if (!pkg.succeeded || packageTotal === undefined || !(packageTotal > 0)) {
      return {
        problem:
          "Newegg did not return a readable cost for every package, so the label cost cannot be " +
          "checked against NEWEGG_MCP_MAX_LABEL_AMOUNT.",
      };
    }
    total += packageTotal;
  }
  if (estimate.packages.length === 0 || !Number.isFinite(total) || !(total > 0)) {
    return {
      problem:
        "The label cost read as 0 or less, so it cannot be checked against NEWEGG_MCP_MAX_LABEL_AMOUNT.",
    };
  }
  return { total, currency: estimate.currency };
}

/** The blocker for a cost above the cap, or undefined when it is within it. */
function overCap(cost: { total: number; currency: string }, cap: number): string | undefined {
  return toCents(cost.total) > toCents(cap)
    ? `The label cost of ${cost.total.toFixed(2)} ${cost.currency} exceeds the server limit of ${cap} (NEWEGG_MCP_MAX_LABEL_AMOUNT).`
    : undefined;
}

/**
 * A Newegg download link is returned only when it is an https `*.newegg.com` URL with a real
 * subdomain label and no userinfo (`https://evil.example@x.newegg.com/` is a lookalike in a
 * rendered link, even though the host is Newegg's).
 */
function safeLink(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      host.endsWith(".newegg.com") &&
      !host.startsWith(".")
    ) {
      return url.toString();
    }
  } catch {
    // not a URL: withheld below
  }
  return undefined;
}

function shapePackage(pkg: ShippingLabelPackageResult) {
  const labelUrl = safeLink(pkg.labelUrl);
  const packingListUrl = safeLink(pkg.packingListUrl);
  return {
    succeeded: pkg.succeeded,
    errorMessage: pkg.errorMessage,
    trackingNumber: pkg.trackingNumber,
    signatureRequired: pkg.signatureRequired,
    labelUrl,
    packingListUrl,
    urlWithheld:
      (pkg.labelUrl !== undefined && labelUrl === undefined) ||
      (pkg.packingListUrl !== undefined && packingListUrl === undefined),
    rate: pkg.rate,
    items: pkg.items,
  };
}

/**
 * Runs a label preview and stores the plan when it is clean. With `NEWEGG_MCP_MAX_LABEL_AMOUNT`
 * set, the plan also carries the quoted cost and is blocked above the cap or when no cost can be
 * determined (`quote`).
 */
async function runLabelPreview<K extends ShippingLabelKind>(
  ctx: ToolContext,
  kind: K,
  plan: () => Promise<ShippingLabelPreview<ShippingLabelInputs[K]>>,
  quote: (input: ShippingLabelInputs[K]) => Promise<LabelCost>,
): Promise<ToolResult> {
  let preview: ShippingLabelPreview<ShippingLabelInputs[K]>;
  try {
    preview = await plan();
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }

  const { maxLabelAmount } = ctx.config.limits;
  const blockers = [...preview.blockers];
  let estimatedCost: number | undefined;
  // Only quote a plan nothing else blocks: the quote is another Newegg call.
  if (maxLabelAmount !== undefined && blockers.length === 0) {
    const cost = await quote(preview.normalized);
    if ("problem" in cost) {
      blockers.push(cost.problem);
    } else {
      estimatedCost = cost.total;
      const exceeded = overCap(cost, maxLabelAmount);
      if (exceeded !== undefined) blockers.push(exceeded);
    }
  }

  const eligible = blockers.length === 0;
  let previewId: string | undefined;
  let previewExpiresAt: string | undefined;
  if (eligible) {
    const costCents = estimatedCost === undefined ? undefined : toCents(estimatedCost);
    const createdAt = ctx.now();
    const expiresAt = new Date(createdAt.getTime() + ctx.config.limits.previewTtlSeconds * 1000);
    previewId = randomBytes(32).toString("base64url");
    previewExpiresAt = expiresAt.toISOString();
    const record = {
      previewId,
      kind,
      hash: hashInput(kind, preview.marketplace, preview.normalized, costCents),
      marketplace: preview.marketplace,
      input: preview.normalized,
      costCents,
      createdAt,
      expiresAt,
    } as ShippingLabelPreviewRecord;
    await ctx.previewStore.put(record);
  }

  return okResult({
    operationId: randomUUID(),
    correlationId: preview.correlationId,
    marketplace: preview.marketplace,
    mode: "preview",
    operation: preview.operation,
    currency: preview.currency,
    orderNumber: preview.orderNumber,
    eligible,
    blockers,
    warnings: preview.warnings,
    request: { ...preview.normalized },
    estimatedCost,
    maxLabelAmount,
    previewId,
    previewExpiresAt,
  });
}

/**
 * Consumes a preview (single use), re-checks its hash and runs the matching SDK write. An
 * ambiguous outcome is reported with the SDK's recovery guidance and the explicit instruction not
 * to retry: a second create could buy a second label.
 */
async function runLabelApply<K extends ShippingLabelKind>(
  ctx: ToolContext,
  kind: K,
  previewId: string,
  quote: (input: ShippingLabelInputs[K]) => Promise<LabelCost>,
  send: (input: ShippingLabelInputs[K]) => Promise<Record<string, unknown>>,
): Promise<ToolResult> {
  const outcome = await consumeTypedPreview(ctx, previewId, kind);
  if ("error" in outcome) {
    return outcome.error;
  }
  const record = outcome.record as unknown as {
    kind: K;
    hash: string;
    marketplace: string;
    input: ShippingLabelInputs[K];
    costCents?: number;
  };

  if (hashInput(kind, record.marketplace, record.input, record.costCents) !== record.hash) {
    return errorResult(
      businessError(
        "preview_tampered",
        "The stored preview no longer matches its hash, so nothing was sent. The preview has been " +
          "consumed; create a new preview.",
      ),
    );
  }

  // Opt-in cost ceiling, re-checked against a fresh quote because the carrier rate may have moved.
  const { maxLabelAmount } = ctx.config.limits;
  if (maxLabelAmount !== undefined) {
    const cost = await quote(record.input);
    const problem = "problem" in cost ? cost.problem : overCap(cost, maxLabelAmount);
    if (problem !== undefined) {
      return errorResult(
        businessError(
          "preview_stale",
          `Nothing was sent: ${problem} The preview has been consumed; create a new preview and review it.`,
        ),
      );
    }
  }

  try {
    const result = await send(record.input);
    return okResult({ operationId: randomUUID(), mode: "apply", previewId, ...result });
  } catch (error) {
    if (error instanceof IndeterminateOrderWriteError) {
      const payload = mapErrorToPayload(error, ctx.logger);
      payload.message = `${payload.message} ${error.guidance} Do NOT retry until you have verified the current state; the preview has been consumed.`;
      return errorResult(payload);
    }
    return errorResult(appendConsumedNote(mapErrorToPayload(error, ctx.logger)));
  }
}

const applyInputSchema = (previewTool: string) =>
  z
    .strictObject({
      previewId: z.string().min(1).describe(`The single-use previewId returned by ${previewTool}.`),
    })
    .describe("The previewId to apply. Nothing else can be supplied here.");

const applyCreateInputSchema = applyInputSchema(TOOL_NAMES.shippingLabelPreviewCreate);
const applyReprintInputSchema = applyInputSchema(TOOL_NAMES.shippingLabelPreviewReprint);

export const shippingLabelPreviewCreateTool: ToolDefinition<
  typeof shippingLabelRequestSchema,
  typeof previewOutputSchema
> = {
  name: TOOL_NAMES.shippingLabelPreviewCreate,
  title: "Preview buying a UPS shipping label",
  description:
    "Plan a Newegg Shipping Label Request WITHOUT buying anything. Validates the request (service " +
    "code, UPS size and weight limits, ZIP/postal code) and reads the order to report BLOCKERS " +
    "(unknown order, Newegg-fulfilled, not unshipped, seller part number not on the order, " +
    "quantity not the whole line, non-US destination) and WARNINGS (existing packages, uncovered " +
    "lines, signature surcharge). When NEWEGG_MCP_MAX_LABEL_AMOUNT is set it also quotes the label " +
    "cost (estimatedCost; one estimate request, which Newegg documents as side-effect free but is " +
    "unverified live) and blocks a cost above the cap or one that cannot be determined. Only a " +
    `clean plan gets a single-use previewId for newegg_shipping_label_apply_create. ${COST_WARNING} ` +
    "No Newegg mutation happens here.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: shippingLabelRequestSchema,
  outputSchema: previewOutputSchema,
  handler: (input: z.infer<typeof shippingLabelRequestSchema>, ctx: ToolContext) =>
    runLabelPreview(
      ctx,
      "shippingLabelCreate",
      () => ctx.client.shippingLabels.previewCreate(input),
      (normalized) => quoteCreateCost(ctx, normalized),
    ),
};

export const shippingLabelApplyCreateTool: ToolDefinition<
  typeof applyCreateInputSchema,
  typeof applyOutputSchema
> = {
  name: TOOL_NAMES.shippingLabelApplyCreate,
  title: "Buy a previewed UPS shipping label",
  description:
    "BUY the shipping label(s) captured by a previewId from newegg_shipping_label_preview_create. " +
    "This charges the seller's Newegg account for the UPS label, marks the order shipped and " +
    "returns tracking numbers and label links. Accepts only the previewId; single-use. If the " +
    "outcome is unknown (timeout, 5xx) the error says so and the write is NOT retried: check the " +
    "order with newegg_orders_get_status and use newegg_shipping_label_preview_reprint to fetch " +
    `an existing label instead of buying another. ${COST_WARNING} With NEWEGG_MCP_MAX_LABEL_AMOUNT ` +
    "set, a fresh quote above the cap (or no readable quote) stops the purchase. Exists only when the " +
    "server is started with writes enabled.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: applyCreateInputSchema,
  outputSchema: applyOutputSchema,
  handler: (input, ctx) =>
    runLabelApply(
      ctx,
      "shippingLabelCreate",
      input.previewId,
      (stored) => quoteCreateCost(ctx, stored),
      async (stored) => {
        const result = await ctx.client.shippingLabels.create(stored);
        return {
          correlationId: result.correlationId,
          marketplace: result.marketplace,
          operation: result.operation,
          orderNumber: result.orderNumber,
          currency: result.currency,
          shipDate: result.shipDate,
          packages: result.packages.map(shapePackage),
          succeededCount: result.succeededCount,
          failedCount: result.failedCount,
          totalCharged: result.totalCharged,
          rateLimit: serializeRateLimit(result.rateLimit),
        };
      },
    ),
};

const reprintInputSchema = z
  .strictObject({
    orderNumber: numberInputSchema.describe("The shipped Newegg order whose label to reprint."),
  })
  .describe("The reprint to plan.");

export const shippingLabelPreviewReprintTool: ToolDefinition<
  typeof reprintInputSchema,
  typeof previewOutputSchema
> = {
  name: TOOL_NAMES.shippingLabelPreviewReprint,
  title: "Preview reprinting a UPS shipping label",
  description:
    "Plan a Newegg Shipping Label Reprint Request WITHOUT sending it. Reads the order and reports " +
    "BLOCKERS (unknown order, Newegg-fulfilled, order not shipped yet). Newegg does not say " +
    "whether a reprint is billed, so it is treated as billable and, because it has no quote, it is " +
    "BLOCKED while NEWEGG_MCP_MAX_LABEL_AMOUNT is set. Only a clean plan gets a single-use " +
    "previewId for newegg_shipping_label_apply_reprint. No Newegg mutation happens here.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: reprintInputSchema,
  outputSchema: previewOutputSchema,
  handler: (input: z.infer<typeof reprintInputSchema>, ctx: ToolContext) =>
    runLabelPreview(
      ctx,
      "shippingLabelReprint",
      () => ctx.client.shippingLabels.previewReprint(input.orderNumber),
      async () => ({ problem: REPRINT_UNQUOTABLE }),
    ),
};

export const shippingLabelApplyReprintTool: ToolDefinition<
  typeof applyReprintInputSchema,
  typeof applyOutputSchema
> = {
  name: TOOL_NAMES.shippingLabelApplyReprint,
  title: "Reprint a previewed UPS shipping label",
  description:
    "Request the reprint captured by a previewId from newegg_shipping_label_preview_reprint and " +
    "return the order's tracking numbers and label links. Newegg does not document whether a " +
    "reprint is billed, so it is treated as a charge. Accepts only the previewId; single-use. If " +
    "the outcome is unknown the error says so and the write is NOT retried. Exists only when the " +
    "server is started with writes enabled.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: applyReprintInputSchema,
  outputSchema: applyOutputSchema,
  handler: (input, ctx) =>
    runLabelApply(
      ctx,
      "shippingLabelReprint",
      input.previewId,
      async () => ({ problem: REPRINT_UNQUOTABLE }),
      async (stored) => {
        const result = await ctx.client.shippingLabels.reprint(stored.orderNumber);
        const packages = result.packages.map(shapePackage);
        return {
          correlationId: result.correlationId,
          marketplace: result.marketplace,
          operation: result.operation,
          orderNumber: result.orderNumber,
          orderStatus: result.orderStatus,
          packages,
          succeededCount: packages.filter((pkg) => pkg.succeeded).length,
          failedCount: packages.filter((pkg) => !pkg.succeeded).length,
          rateLimit: serializeRateLimit(result.rateLimit),
        };
      },
    ),
};
