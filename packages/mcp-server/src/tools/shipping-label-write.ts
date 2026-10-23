/**
 * Shipping Label WRITE tools (contracts §23): `newegg_shipping_label_preview_create` /
 * `newegg_shipping_label_apply_create` (BUYS a UPS label, bills the seller's Newegg account and
 * ships the order) and `newegg_shipping_label_preview_reprint` / `newegg_shipping_label_apply_reprint`
 * (re-issues a label; billing unknown, treated as billable). All four are registered only when
 * `NEWEGG_MCP_ALLOW_WRITES=true`; apply accepts only a previewId (ADR 0005).
 *
 * The label download links Newegg returns are bearer links: they are surfaced only when they point
 * at a `*.newegg.com` https host, and customer data (the ship-to address) is never returned.
 * `NEWEGG_MCP_MAX_LABEL_AMOUNT` is a cost ceiling that is ON by default (100, marketplace currency):
 * the create preview carries Newegg's quote and is blocked above the cap (re-checked at apply
 * against both the stored quote and a fresh one), and any cost that cannot be determined (a failed
 * quote, an unrated package, or a reprint, which has no quote) is blocked too. The cap is lifted
 * only by the explicit `NEWEGG_MCP_MAX_LABEL_AMOUNT=unlimited`, after which a human must read the
 * preview before applying. A reprint alone can be let through a cap with the separate opt-in
 * `NEWEGG_MCP_ALLOW_LABEL_REPRINT=true` (recovery after an indeterminate create). Every reprint, allowed
 * or not by the cap, is also bounded by an in-memory per-order cooldown and per-hour counter
 * (`label-reprint-limiter.ts`), reported at preview and enforced at apply.
 *
 * A create is also guarded per order (T-6212): the SDK records every create attempt in its
 * operation store before dispatch, and a new create for an order whose earlier create was
 * indeterminate or succeeded is refused (preview blocker, and `label_create_already_attempted` at
 * apply, nothing sent). The guard is checked FIRST at apply, before any quote or order read, so a
 * blocked order makes no request. No tool argument clears it: the SDK's acknowledgement option is
 * deliberately not exposed, because an agent could simply pass it back. The operator verifies the
 * order in the Seller Portal and restarts the server; the record is in memory unless
 * NEWEGG_MCP_OPERATION_STORE_FILE keeps it in a file (T-6280), in which case the operator also clears
 * it from the shell with `--clear-label-guard`, a command no tool can reach.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  IndeterminateOrderWriteError,
  LabelCreateGuardError,
} from "@devino/newegg-marketplace-sdk";
import type { ShippingLabelCreateOptions } from "@devino/newegg-marketplace-sdk";
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
import { hashLabelPreview, sealFor } from "./preview-hash.js";
import { TOOL_NAMES } from "./names.js";
import { reprintLimiterFor, type ReprintLimiter } from "./label-reprint-limiter.js";

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
  /** Create only: the earlier label create for this order that blocks this one. */
  priorAttempt: z
    .object({
      state: z.enum(["submitting", "submitted"]),
      atIso: z.string(),
    })
    .optional(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  /** The exact normalized request the apply tool will send. */
  request: z.record(z.string(), z.unknown()),
  /** Newegg's quote for the label(s), present whenever a cap is active (the default). */
  estimatedCost: z.number().optional(),
  /** The configured NEWEGG_MCP_MAX_LABEL_AMOUNT, absent only when it was set to "unlimited". */
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
  "apply after a human has read the preview. Unless NEWEGG_MCP_MAX_LABEL_AMOUNT=unlimited the preview " +
  "carries the quoted cost and is blocked above that cap (default 100, marketplace currency).";

const toCents = (amount: number): number => Math.round(amount * 100);

/**
 * The remedy shown for a blocked create. The MCP offers no way to clear a block, on purpose: the
 * attempt id would reach the agent that is being guarded.
 */
const CREATE_BLOCK_GUIDANCE =
  "Verify in the Seller Portal whether a label already exists for this order (the order status " +
  "can lag, so newegg_orders_get_status alone cannot prove there is none). No tool argument " +
  "clears this block: only after that check, the operator restarts this MCP server (the record " +
  "is kept in memory) and then creates the preview again.";

/** The same remedy when the ledger lives in a file: a restart alone no longer forgets it. */
const PERSISTENT_CREATE_BLOCK_GUIDANCE =
  "Verify in the Seller Portal whether a label already exists for this order (the order status " +
  "can lag, so newegg_orders_get_status alone cannot prove there is none). No tool argument " +
  "clears this block, and a restart does not either (the record is kept in a file): only after " +
  "that check, the operator runs `newegg-marketplace-mcp --clear-label-guard <marketplace> " +
  "<order number>` on the server host and restarts this MCP server, and then the preview can be " +
  "created again.";

/** Passed to the SDK so its blockers and errors carry the MCP remedy instead of the SDK option. */
function createGuardOptions(ctx: ToolContext): ShippingLabelCreateOptions {
  return {
    priorAttemptGuidance:
      ctx.config.operationStoreFile === undefined
        ? CREATE_BLOCK_GUIDANCE
        : PERSISTENT_CREATE_BLOCK_GUIDANCE,
  };
}

/** The cost of a label, or the reason it could not be determined. */
type LabelCost =
  | { total: number; currency: string }
  | { problem: string }
  /** Nothing to check against the cap (an operator-allowed reprint); carries a preview warning. */
  | { unmetered: string };

/** A reprint has no quote: Newegg's reprint request carries only the order number. */
const REPRINT_UNQUOTABLE =
  "The cost of a reprint cannot be determined (Newegg has no quote for it and does not say whether " +
  "it is billed), so it cannot be checked against NEWEGG_MCP_MAX_LABEL_AMOUNT. To reprint after a " +
  "human review the operator must set NEWEGG_MCP_ALLOW_LABEL_REPRINT=true (the create cap stays), " +
  "or restart with NEWEGG_MCP_MAX_LABEL_AMOUNT=unlimited (which lifts the create cap too).";

const REPRINT_UNMETERED =
  "Reprint allowed by NEWEGG_MCP_ALLOW_LABEL_REPRINT=true: Newegg has no quote for a reprint, so " +
  "NEWEGG_MCP_MAX_LABEL_AMOUNT is not applied to it.";

/** Shown on every reprint preview, whichever way the cap is configured. */
const REPRINT_MAY_BE_CHARGED =
  "This reprint may be charged; the amount is unknown (Newegg does not say whether a reprint is " +
  "billed). Check the order's existing label first.";

/** Per-order cooldown and per-hour counter of this server instance. */
const limiterFor = (ctx: ToolContext): ReprintLimiter =>
  reprintLimiterFor(ctx.previewStore, {
    cooldownSeconds: ctx.config.limits.labelReprintCooldownSeconds,
    maxPerHour: ctx.config.limits.maxLabelReprintsPerHour,
  });

/** Reprint-only preview additions: the billing warning and the limiter's current verdict (no reservation). */
const reprintPreviewExtras = (ctx: ToolContext) => ({
  warnings: [
    `${REPRINT_MAY_BE_CHARGED} Limits: 1 per order per ${ctx.config.limits.labelReprintCooldownSeconds} s and ` +
      `${ctx.config.limits.maxLabelReprintsPerHour} per hour, counted from apply (in memory, reset on restart).`,
  ],
  refused: (input: ShippingLabelInputs["shippingLabelReprint"]) =>
    limiterFor(ctx).check(String(input.orderNumber), ctx.now().getTime()),
});

/** Reprint "quote": blocked under a cap unless the operator opted in to label reprints. */
const reprintCost = (ctx: ToolContext) => async (): Promise<LabelCost> =>
  ctx.config.limits.allowLabelReprint
    ? { unmetered: REPRINT_UNMETERED }
    : { problem: REPRINT_UNQUOTABLE };

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
 * Runs a label preview and stores the plan when it is clean. While a cap is active (the default;
 * `NEWEGG_MCP_MAX_LABEL_AMOUNT` not `unlimited`), the plan also carries the quoted cost and is blocked above the cap or when no cost can be
 * determined (`quote`).
 */
async function runLabelPreview<K extends ShippingLabelKind>(
  ctx: ToolContext,
  kind: K,
  plan: () => Promise<ShippingLabelPreview<ShippingLabelInputs[K]>>,
  quote: (input: ShippingLabelInputs[K]) => Promise<LabelCost>,
  extras?: {
    warnings: string[];
    refused: (input: ShippingLabelInputs[K]) => string | undefined;
  },
): Promise<ToolResult> {
  let preview: ShippingLabelPreview<ShippingLabelInputs[K]>;
  try {
    preview = await plan();
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }

  const { maxLabelAmount } = ctx.config.limits;
  const blockers = [...preview.blockers];
  const warnings = [...preview.warnings];
  let estimatedCost: number | undefined;
  if (extras !== undefined) warnings.push(...extras.warnings);
  // Only quote a plan nothing else blocks: the quote is another Newegg call.
  if (maxLabelAmount !== undefined && blockers.length === 0) {
    const cost = await quote(preview.normalized);
    if ("problem" in cost) {
      blockers.push(cost.problem);
    } else if ("unmetered" in cost) {
      warnings.push(cost.unmetered);
    } else {
      estimatedCost = cost.total;
      const exceeded = overCap(cost, maxLabelAmount);
      if (exceeded !== undefined) blockers.push(exceeded);
    }
  }

  if (extras !== undefined && blockers.length === 0) {
    const refused = extras.refused(preview.normalized);
    if (refused !== undefined) blockers.push(refused);
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
      hash: hashLabelPreview(
        sealFor(ctx, previewId, expiresAt),
        kind,
        preview.marketplace,
        preview.normalized,
        costCents,
      ),
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
    priorAttempt:
      preview.priorAttempt === undefined
        ? undefined
        : { state: preview.priorAttempt.state, atIso: preview.priorAttempt.atIso },
    blockers,
    warnings,
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
  preflight?: (input: ShippingLabelInputs[K]) => Promise<ToolResult | undefined>,
  reserve?: (input: ShippingLabelInputs[K]) => string | undefined,
): Promise<ToolResult> {
  const outcome = await consumeTypedPreview(ctx, previewId, kind);
  if ("error" in outcome) {
    return outcome.error;
  }
  const record = outcome.record as unknown as {
    kind: K;
    marketplace: string;
    input: ShippingLabelInputs[K];
    costCents?: number;
  };

  // Cheapest, ledger-only refusals first: a blocked order must make no request (no quote, no
  // order read).
  const blocked = await preflight?.(record.input);
  if (blocked !== undefined) return blocked;

  // Cost ceiling, re-checked against the CURRENT cap: first the amount stored at preview time (the
  // cap may be lower than when the preview was made), then a fresh quote because the carrier rate
  // may have moved. A preview made with no cap stores no amount and is quoted fresh.
  const { maxLabelAmount } = ctx.config.limits;
  if (maxLabelAmount !== undefined) {
    if (record.costCents !== undefined && record.costCents > toCents(maxLabelAmount)) {
      return errorResult(
        businessError(
          "preview_stale",
          `Nothing was sent: the previewed label cost of ${(record.costCents / 100).toFixed(2)} exceeds the server limit of ${maxLabelAmount} (NEWEGG_MCP_MAX_LABEL_AMOUNT). The preview has been consumed; create a new preview and review it.`,
        ),
      );
    }
    const cost = await quote(record.input);
    const problem =
      "problem" in cost
        ? cost.problem
        : "unmetered" in cost
          ? undefined
          : overCap(cost, maxLabelAmount);
    if (problem !== undefined) {
      return errorResult(
        businessError(
          "preview_stale",
          `Nothing was sent: ${problem} The preview has been consumed; create a new preview and review it.`,
        ),
      );
    }
  }

  // Last gate before the write, with nothing awaited between the check and the send: a refusal is
  // reported here, an admitted attempt is already recorded.
  const limited = reserve?.(record.input);
  if (limited !== undefined) {
    return errorResult(
      businessError(
        "reprint_rate_limited",
        `Nothing was sent: ${limited} The preview has been consumed; create a new preview later.`,
      ),
    );
  }

  try {
    const result = await send(record.input);
    return okResult({ operationId: randomUUID(), mode: "apply", previewId, ...result });
  } catch (error) {
    if (error instanceof LabelCreateGuardError) return createBlockedResult(error);
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

/** The refusal of a create whose order has a blocking earlier attempt: nothing was sent. */
function createBlockedResult(error: LabelCreateGuardError): ToolResult {
  return errorResult(
    businessError(
      "label_create_already_attempted",
      `Nothing was sent: ${error.message} The preview has been consumed.`,
    ),
  );
}

/** Ledger-only apply check for a create: no Newegg request, so it runs before the quote. */
async function createPreflight(
  ctx: ToolContext,
  input: ShippingLabelInputs["shippingLabelCreate"],
): Promise<ToolResult | undefined> {
  try {
    await ctx.client.shippingLabels.assertCreateNotBlocked(
      input.orderNumber,
      createGuardOptions(ctx),
    );
    return undefined;
  } catch (error) {
    if (error instanceof LabelCreateGuardError) return createBlockedResult(error);
    return errorResult(appendConsumedNote(mapErrorToPayload(error, ctx.logger)));
  }
}

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
    "lines, signature surcharge) and BLOCKS an order whose earlier label create (last 24 h by default; " +
    "remembered across restarts only when the operator configured a persistent ledger) timed out, failed with an unknown outcome or succeeded, because the order status can lag " +
    "and a second create would buy a second label (priorAttempt reports it). No tool argument clears " +
    "that block: the operator verifies the order in the Seller Portal and restarts the server. " +
    "Unless NEWEGG_MCP_MAX_LABEL_AMOUNT=unlimited it also quotes the label " +
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
      () => ctx.client.shippingLabels.previewCreate(input, createGuardOptions(ctx)),
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
    "outcome is unknown (timeout, 5xx) the error says so and the write is NOT retried, and a later create " +
    "for the same order is refused (label_create_already_attempted, nothing sent, no request made) until " +
    "the operator has verified the order in the Seller Portal and restarted the server: check the " +
    "order with newegg_orders_get_status and use newegg_shipping_label_preview_reprint to fetch " +
    "an existing label instead of buying another (while a label cap is active that reprint is " +
    "blocked unless the operator has set NEWEGG_MCP_ALLOW_LABEL_REPRINT=true, or restarted with " +
    `NEWEGG_MCP_MAX_LABEL_AMOUNT=unlimited). ${COST_WARNING} Unless NEWEGG_MCP_MAX_LABEL_AMOUNT ` +
    "is unlimited, a fresh quote above the cap (or no readable quote) stops the purchase. Exists only when the " +
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
        const result = await ctx.client.shippingLabels.create(stored, createGuardOptions(ctx));
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
      (stored) => createPreflight(ctx, stored),
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
    "BLOCKED unless the operator has set NEWEGG_MCP_ALLOW_LABEL_REPRINT=true (or " +
    "NEWEGG_MCP_MAX_LABEL_AMOUNT=unlimited). A reprint may be charged (amount unknown) and is also " +
    "limited to one per order per cooldown window and a per-hour count (reported here, enforced at " +
    "apply). Only a clean plan gets a single-use previewId for " +
    "newegg_shipping_label_apply_reprint. No Newegg mutation happens here.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: reprintInputSchema,
  outputSchema: previewOutputSchema,
  handler: (input: z.infer<typeof reprintInputSchema>, ctx: ToolContext) =>
    runLabelPreview(
      ctx,
      "shippingLabelReprint",
      () => ctx.client.shippingLabels.previewReprint(input.orderNumber),
      reprintCost(ctx),
      reprintPreviewExtras(ctx),
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
    "reprint is billed, so it is treated as a charge. Refused (nothing sent, preview consumed) when " +
    "the order was already reprinted inside the cooldown window or the per-hour reprint limit is " +
    "reached. Accepts only the previewId; single-use. If " +
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
      reprintCost(ctx),
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
      undefined,
      (stored) => limiterFor(ctx).reserve(String(stored.orderNumber), ctx.now().getTime()),
    ),
};
