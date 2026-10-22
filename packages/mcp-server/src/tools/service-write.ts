/**
 * Shared scaffolding of the RMA and courtesy-refund write tools (contracts §20). These tools move
 * customer money or change a customer's return, so they follow ADR 0005 to the letter and add two
 * guards of their own: a server-side refund ceiling (`NEWEGG_MCP_MAX_REFUND_AMOUNT`, enforced at
 * preview time, in code) and a hash check that the stored input has not changed between preview
 * and apply. Per ADR 0001 this layer is MCP-SDK-free.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { IndeterminateServiceWriteError } from "@devino/newegg-marketplace-sdk";
import type { ServiceWritePreview } from "@devino/newegg-marketplace-sdk";
import type {
  ServiceWriteInputs,
  ServiceWriteKind,
  ServiceWritePreviewRecord,
} from "../preview-store/index.js";
import {
  businessError,
  errorResult,
  mapErrorToPayload,
  marketplaceSchema,
  okResult,
  rateLimitOutputSchema,
  type ToolContext,
  type ToolResult,
} from "./shared.js";
import { appendConsumedNote, consumeTypedPreview } from "./preview-apply-core.js";
import { hashServicePreview, sealFor } from "./preview-hash.js";

const serviceWriteOperationSchema = z.enum([
  "rma.submit",
  "rma.edit",
  "rma.receive",
  "rma.reject",
  "refunds.issue",
]);

/** Output of every preview tool. */
export const servicePreviewOutputSchema = z.object({
  operationId: z.string(),
  correlationId: z.string(),
  marketplace: marketplaceSchema,
  mode: z.literal("preview"),
  operation: serviceWriteOperationSchema,
  currency: z.enum(["USD", "CAD"]),
  orderNumber: z.string().optional(),
  rmaNumber: z.string().optional(),
  /** Money the write moves, in `currency`. */
  refundTotal: z.number().optional(),
  /** The server-side ceiling the refund total was checked against. */
  maxRefundAmount: z.number(),
  /** True when nothing blocks the write; only then is a previewId issued. */
  eligible: z.boolean(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  /** The exact normalized request the apply tool will send. */
  request: z.record(z.string(), z.unknown()),
  previewId: z.string().optional(),
  previewExpiresAt: z.string().optional(),
});

const applyItemSchema = z.object({
  sellerPartNumber: z.string().optional(),
  returnQuantity: z.number().optional(),
  returnUnitPrice: z.number().optional(),
  refundShippingPrice: z.number().optional(),
  reason: z.string(),
});

/** Output of every apply tool (RMA writes fill `rma`, the courtesy refund fills `courtesyRefund`). */
export const serviceApplyOutputSchema = z.object({
  operationId: z.string(),
  correlationId: z.string(),
  marketplace: marketplaceSchema,
  mode: z.literal("apply"),
  operation: serviceWriteOperationSchema,
  currency: z.enum(["USD", "CAD"]),
  previewId: z.string(),
  rma: z
    .object({
      rmaNumber: z.string(),
      type: z.string(),
      status: z.string(),
      statusDescription: z.string().optional(),
      sellerRmaNumber: z.string().optional(),
      orderNumber: z.string().optional(),
      items: z.array(applyItemSchema),
    })
    .optional(),
  courtesyRefund: z
    .object({
      requestId: z.string(),
      state: z.string(),
      stateRaw: z.string().optional(),
      requestDate: z.string().optional(),
      orderNumber: z.string(),
      amount: z.number(),
    })
    .optional(),
  rateLimit: rateLimitOutputSchema.optional(),
});

/** Digit-string order / RMA number input (the SDK validates it further). */
export const numberInputSchema = z.union([z.string().min(1).max(15), z.number().int().positive()]);

const toCents = (amount: number): number => Math.round(amount * 100);

const formatCents = (cents: number | undefined): string =>
  cents === undefined ? "none" : (cents / 100).toFixed(2);

/** Runs a preview, enforces the refund ceiling in code, and stores the plan when it is clean. */
export async function runServicePreview<K extends ServiceWriteKind>(
  ctx: ToolContext,
  kind: K,
  plan: () => Promise<ServiceWritePreview<ServiceWriteInputs[K]>>,
): Promise<ToolResult> {
  let preview: ServiceWritePreview<ServiceWriteInputs[K]>;
  try {
    preview = await plan();
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }

  const { limits } = ctx.config;
  const blockers = [...preview.blockers];
  if (preview.refundTotal !== undefined && preview.refundTotal > limits.maxRefundAmount) {
    blockers.push(
      `The refund of ${preview.refundTotal.toFixed(2)} ${preview.currency} exceeds the server limit of ` +
        `${limits.maxRefundAmount} (NEWEGG_MCP_MAX_REFUND_AMOUNT).`,
    );
  }

  // Fail closed: a refund-type write that moves no readable money must never pass the ceiling by
  // looking like it moves nothing.
  if (preview.refundTotal !== undefined && !(preview.refundTotal > 0)) {
    blockers.push(
      "The refund amount of this RMA could not be read (it reads as 0), so it cannot be checked against " +
        "NEWEGG_MCP_MAX_REFUND_AMOUNT. Inspect it with newegg_rma_get.",
    );
  }

  const eligible = blockers.length === 0;
  let previewId: string | undefined;
  let previewExpiresAt: string | undefined;
  if (eligible) {
    const refundCents =
      preview.refundTotal === undefined ? undefined : toCents(preview.refundTotal);
    const createdAt = ctx.now();
    const expiresAt = new Date(createdAt.getTime() + limits.previewTtlSeconds * 1000);
    previewId = randomBytes(32).toString("base64url");
    previewExpiresAt = expiresAt.toISOString();
    const record = {
      previewId,
      kind,
      hash: hashServicePreview(
        sealFor(ctx, previewId, expiresAt),
        kind,
        preview.marketplace,
        preview.normalized,
        refundCents,
      ),
      marketplace: preview.marketplace,
      input: preview.normalized,
      refundCents,
      createdAt,
      expiresAt,
    } as ServiceWritePreviewRecord;
    await ctx.previewStore.put(record);
  }

  const rmaNumber = (preview.normalized as { rmaNumber?: string | number }).rmaNumber;
  return okResult({
    operationId: randomUUID(),
    correlationId: preview.correlationId,
    marketplace: preview.marketplace,
    mode: "preview",
    operation: preview.operation,
    currency: preview.currency,
    orderNumber: preview.orderNumber,
    rmaNumber: rmaNumber === undefined ? undefined : String(rmaNumber),
    refundTotal: preview.refundTotal,
    maxRefundAmount: limits.maxRefundAmount,
    eligible,
    blockers,
    warnings: preview.warnings,
    request: { ...preview.normalized },
    previewId,
    previewExpiresAt,
  });
}

/**
 * Consumes a preview (single use), re-checks its hash, runs the matching SDK write and shapes the
 * structured output. An ambiguous outcome is reported with the SDK's recovery guidance and the
 * explicit instruction not to retry blindly.
 *
 * `recheck` re-plans the write just before it is sent (reads only) for operations whose money is read
 * from Newegg rather than supplied by the caller (Process RMA releases whatever the RMA refunds NOW).
 * The write is aborted when the fresh plan has blockers, when its refund differs from the previewed
 * figure, or when it exceeds the server ceiling.
 */
export async function runServiceApply<K extends ServiceWriteKind>(
  ctx: ToolContext,
  kind: K,
  previewId: string,
  send: (input: ServiceWriteInputs[K]) => Promise<Record<string, unknown>>,
  recheck?: (input: ServiceWriteInputs[K]) => Promise<ServiceWritePreview<unknown>>,
): Promise<ToolResult> {
  const outcome = await consumeTypedPreview(ctx, previewId, kind);
  if ("error" in outcome) {
    return outcome.error;
  }
  const record = outcome.record as unknown as {
    kind: K;
    marketplace: string;
    input: ServiceWriteInputs[K];
    refundCents?: number;
  };

  if (recheck !== undefined) {
    let fresh: ServiceWritePreview<unknown>;
    try {
      fresh = await recheck(record.input);
    } catch (error) {
      return errorResult(appendConsumedNote(mapErrorToPayload(error, ctx.logger)));
    }
    const freshCents = fresh.refundTotal === undefined ? undefined : toCents(fresh.refundTotal);
    const { maxRefundAmount } = ctx.config.limits;
    const problems: string[] = [...fresh.blockers];
    if (freshCents !== record.refundCents) {
      problems.push(
        `The refund changed since the preview (previewed ${formatCents(record.refundCents)}, now ${formatCents(freshCents)} ${fresh.currency}).`,
      );
    }
    if (fresh.refundTotal !== undefined && fresh.refundTotal > maxRefundAmount) {
      problems.push(
        `The refund of ${fresh.refundTotal.toFixed(2)} ${fresh.currency} exceeds the server limit of ${maxRefundAmount} (NEWEGG_MCP_MAX_REFUND_AMOUNT).`,
      );
    }
    if (problems.length > 0) {
      return errorResult(
        businessError(
          "preview_stale",
          `Nothing was sent: ${problems.join(" ")} The preview has been consumed; create a new preview and review it.`,
        ),
      );
    }
  }

  try {
    const result = await send(record.input);
    return okResult({ operationId: randomUUID(), mode: "apply", previewId, ...result });
  } catch (error) {
    if (error instanceof IndeterminateServiceWriteError) {
      const payload = mapErrorToPayload(error, ctx.logger);
      payload.message = `${payload.message} ${error.guidance} Do NOT retry until you have verified the current state; the preview has been consumed.`;
      return errorResult(payload);
    }
    return errorResult(appendConsumedNote(mapErrorToPayload(error, ctx.logger)));
  }
}
