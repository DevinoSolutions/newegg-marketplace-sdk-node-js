/**
 * Shipping Label WRITE tools (contracts §23): `newegg_shipping_label_preview_create` /
 * `newegg_shipping_label_apply_create` (BUYS a UPS label, bills the seller's Newegg account and
 * ships the order) and `newegg_shipping_label_preview_reprint` / `newegg_shipping_label_apply_reprint`
 * (re-issues a label; billing unknown, treated as billable). All four are registered only when
 * `NEWEGG_MCP_ALLOW_WRITES=true`; apply accepts only a previewId (ADR 0005).
 *
 * The label download links Newegg returns are bearer links: they are surfaced only when they point
 * at a `*.newegg.com` https host, and customer data (the ship-to address) is never returned.
 * There is no server-side cost ceiling: Newegg's quote is available from
 * `newegg_shipping_label_estimate`, and a human must read the preview before applying.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { IndeterminateOrderWriteError } from "@devino/newegg-marketplace-sdk";
import type {
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
  "the order shipped and cannot be undone through this server; the call is not idempotent. Run " +
  "newegg_shipping_label_estimate first and only apply after a human has read the preview.";

function hashInput(kind: ShippingLabelKind, marketplace: string, input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind, marketplace, input }), "utf8")
    .digest("hex");
}

/** A Newegg download link is returned only when it is an https `*.newegg.com` URL. */
function safeLink(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname.toLowerCase().endsWith(".newegg.com")) {
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

/** Runs a label preview and stores the plan when it is clean. */
async function runLabelPreview<K extends ShippingLabelKind>(
  ctx: ToolContext,
  kind: K,
  plan: () => Promise<ShippingLabelPreview<ShippingLabelInputs[K]>>,
): Promise<ToolResult> {
  let preview: ShippingLabelPreview<ShippingLabelInputs[K]>;
  try {
    preview = await plan();
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }

  const eligible = preview.blockers.length === 0;
  let previewId: string | undefined;
  let previewExpiresAt: string | undefined;
  if (eligible) {
    const createdAt = ctx.now();
    const expiresAt = new Date(
      createdAt.getTime() + ctx.config.limits.previewTtlSeconds * 1000,
    );
    previewId = randomBytes(32).toString("base64url");
    previewExpiresAt = expiresAt.toISOString();
    const record = {
      previewId,
      kind,
      hash: hashInput(kind, preview.marketplace, preview.normalized),
      marketplace: preview.marketplace,
      input: preview.normalized,
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
    blockers: preview.blockers,
    warnings: preview.warnings,
    request: { ...preview.normalized },
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
  };

  if (hashInput(kind, record.marketplace, record.input) !== record.hash) {
    return errorResult(
      businessError(
        "preview_tampered",
        "The stored preview no longer matches its hash, so nothing was sent. The preview has been " +
          "consumed; create a new preview.",
      ),
    );
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
    "lines, signature surcharge). Only a clean plan gets a single-use previewId for " +
    `newegg_shipping_label_apply_create. ${COST_WARNING} No Newegg mutation happens here.`,
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: shippingLabelRequestSchema,
  outputSchema: previewOutputSchema,
  handler: (input: z.infer<typeof shippingLabelRequestSchema>, ctx: ToolContext) =>
    runLabelPreview(ctx, "shippingLabelCreate", () =>
      ctx.client.shippingLabels.previewCreate(input),
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
    `an existing label instead of buying another. ${COST_WARNING} Exists only when the server is ` +
    "started with writes enabled.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: applyCreateInputSchema,
  outputSchema: applyOutputSchema,
  handler: (input, ctx) =>
    runLabelApply(ctx, "shippingLabelCreate", input.previewId, async (stored) => {
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
    }),
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
    "whether a reprint is billed, so it is treated as billable. Only a clean plan gets a " +
    "single-use previewId for newegg_shipping_label_apply_reprint. No Newegg mutation happens here.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: reprintInputSchema,
  outputSchema: previewOutputSchema,
  handler: (input: z.infer<typeof reprintInputSchema>, ctx: ToolContext) =>
    runLabelPreview(ctx, "shippingLabelReprint", () =>
      ctx.client.shippingLabels.previewReprint(input.orderNumber),
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
    runLabelApply(ctx, "shippingLabelReprint", input.previewId, async (stored) => {
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
    }),
};
