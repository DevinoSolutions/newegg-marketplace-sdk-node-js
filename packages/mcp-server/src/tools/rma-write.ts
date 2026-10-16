/**
 * RMA WRITE tools (contracts §20): Submit, Edit, Process (receive) and Reject RMA, each as a
 * read-only `preview` plus a mutating `apply` (ADR 0005). A refund RMA records, edits or releases a
 * refund to a customer; Reject denies one. Both halves are registered only when
 * `NEWEGG_MCP_ALLOW_WRITES=true`. The preview reads the order / RMA through the SDK, blocks what
 * Newegg would reject, enforces `NEWEGG_MCP_MAX_REFUND_AMOUNT` and issues a single-use previewId;
 * apply accepts only that id and sends exactly the stored request. Customer data (name, address,
 * phone, RMA note, tracking numbers) is never returned.
 */
import { z } from "zod";
import type { RmaWriteResult } from "@devino/newegg-marketplace-sdk";
import type { McpServerConfig } from "../config/index.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./shared.js";
import {
  numberInputSchema,
  runServiceApply,
  runServicePreview,
  servicePreviewOutputSchema,
  serviceApplyOutputSchema,
} from "./service-write.js";
import { serializeRateLimit } from "./shared.js";
import { TOOL_NAMES } from "./names.js";

/** SDK per-call ceiling for lines on one RMA. */
const SDK_MAX_RMA_ITEMS = 50;

const MONEY_WARNING =
  "WARNING: this moves or withholds customer money and is not idempotent; only apply after a human " +
  "has read the preview.";

const writeItemSchema = z
  .strictObject({
    sellerPartNumber: z
      .string()
      .min(1)
      .max(40)
      .describe("Seller part number of an item on the order."),
    returnQuantity: z.number().int().min(1).max(99999).describe("Units returned (> 0)."),
    reason: z
      .enum([
        "itemDamaged",
        "defective",
        "incompatible",
        "noLongerNeeded",
        "notAsDescribed",
        "orderedWrongItem",
        "sentWrongItem",
        "unsatisfied",
        "extraItemShipped",
        "itemNotReceived",
      ])
      .describe(
        "Why the item is returned. incompatible / noLongerNeeded / orderedWrongItem / unsatisfied " +
          "also need unopened, imageUrls and memo (Newegg.com and Newegg.ca).",
      ),
    returnUnitPrice: z
      .number()
      .gt(0)
      .max(99999.99)
      .optional()
      .describe("Refund RMAs only (required there): refund per unit, > 0, at most 2 decimals."),
    refundShippingPrice: z
      .number()
      .min(0)
      .max(99999.99)
      .optional()
      .describe(
        "Refund RMAs only (required there): shipping refund for the line, >= 0 (0 = none).",
      ),
    unopened: z.boolean().optional().describe("Whether the item was returned unopened."),
    imageUrls: z
      .array(z.string().max(2048))
      .min(1)
      .max(5)
      .optional()
      .describe("1-5 evidence image URLs (Newegg.com and Newegg.ca only)."),
    memo: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe("Evidence memo (Newegg.com and Newegg.ca only)."),
  })
  .describe("One returned line of the RMA.");

const rmaTypeSchema = z.enum(["refund", "replacement"]);
const sellerRmaNumberSchema = z
  .string()
  .max(50)
  .optional()
  .describe("Your own RMA reference: letters and digits only, <= 50.");

const applyInputSchema = (previewTool: string) =>
  z
    .strictObject({
      previewId: z.string().min(1).describe(`The single-use previewId returned by ${previewTool}.`),
    })
    .describe("The previewId to apply. Nothing else can be supplied here.");

function serializeRmaResult(result: RmaWriteResult): Record<string, unknown> {
  return {
    correlationId: result.correlationId,
    marketplace: result.marketplace,
    operation: result.operation,
    currency: result.currency,
    rma: {
      rmaNumber: result.rmaNumber,
      type: result.type,
      status: result.status,
      statusDescription: result.statusDescription,
      sellerRmaNumber: result.sellerRmaNumber,
      orderNumber: result.orderNumber,
      items: result.items.map((item) => ({
        sellerPartNumber: item.sellerPartNumber,
        returnQuantity: item.returnQuantity,
        returnUnitPrice: item.returnUnitPrice,
        refundShippingPrice: item.refundShippingPrice,
        reason: item.reason,
      })),
    },
    rateLimit: serializeRateLimit(result.rateLimit),
  };
}

const applyAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const previewAnnotations = { readOnlyHint: true, openWorldHint: true } as const;

// ---------------------------------------------------------------------------
// Submit RMA
// ---------------------------------------------------------------------------
function makeSubmitInputSchema(config: McpServerConfig) {
  const max = Math.min(config.limits.maxItemsPerOperation, SDK_MAX_RMA_ITEMS);
  return z
    .strictObject({
      orderNumber: numberInputSchema.describe("The Newegg order the RMA is for."),
      type: rmaTypeSchema.describe("refund pays the customer; replacement ships a new unit."),
      items: z.array(writeItemSchema).min(1).max(max).describe(`1-${max} returned lines.`),
      sellerRmaNumber: sellerRmaNumberSchema,
      note: z.string().min(1).max(4000).optional().describe("RMA comment, <= 4000."),
    })
    .describe("The RMA to plan. autoReceive is not available through MCP.");
}

type SubmitPreviewSchema = ReturnType<typeof makeSubmitInputSchema>;

export function createRmaPreviewSubmitTool(
  config: McpServerConfig,
): ToolDefinition<SubmitPreviewSchema, typeof servicePreviewOutputSchema> {
  return {
    name: TOOL_NAMES.rmaPreviewSubmit,
    title: "Preview submitting an RMA",
    description:
      "Plan a Newegg Submit RMA WITHOUT changing anything. Reads the order and its existing RMAs and " +
      "courtesy refunds, then reports BLOCKERS (unknown/voided/unshipped/replacement order, item not on " +
      "the order, quantity or refund above what is returnable, refund above the order total minus prior " +
      `refunds, refund above the server limit of ${config.limits.maxRefundAmount}) and WARNINGS ` +
      "(duplicates). Only a clean plan gets a single-use previewId for newegg_rma_apply_submit. " +
      `${MONEY_WARNING} No Newegg mutation happens here.`,
    annotations: previewAnnotations,
    inputSchema: makeSubmitInputSchema(config),
    outputSchema: servicePreviewOutputSchema,
    handler: (input: z.infer<SubmitPreviewSchema>, ctx: ToolContext): Promise<ToolResult> =>
      runServicePreview(ctx, "rmaSubmit", () => ctx.client.rma.previewSubmit(input)),
  };
}

const submitApplyInput = applyInputSchema(TOOL_NAMES.rmaPreviewSubmit);

export const rmaApplySubmitTool: ToolDefinition<
  typeof submitApplyInput,
  typeof serviceApplyOutputSchema
> = {
  name: TOOL_NAMES.rmaApplySubmit,
  title: "Apply a previewed RMA submission",
  description:
    "Submit EXACTLY the RMA captured by a previewId from newegg_rma_preview_submit. A refund RMA " +
    "records a refund to the customer. Accepts only the previewId; the preview is single-use. If the " +
    "outcome is unknown (timeout, 5xx) the error says so and the write is NOT retried: check " +
    "newegg_rma_list for the order before doing anything else. " +
    `${MONEY_WARNING} This tool exists only when the server is started with writes enabled.`,
  annotations: applyAnnotations,
  inputSchema: submitApplyInput,
  outputSchema: serviceApplyOutputSchema,
  handler: (input, ctx) =>
    runServiceApply(ctx, "rmaSubmit", input.previewId, async (stored) =>
      serializeRmaResult(await ctx.client.rma.submit(stored)),
    ),
};

// ---------------------------------------------------------------------------
// Edit RMA
// ---------------------------------------------------------------------------
function makeEditInputSchema(config: McpServerConfig) {
  const max = Math.min(config.limits.maxItemsPerOperation, SDK_MAX_RMA_ITEMS);
  return z
    .strictObject({
      rmaNumber: numberInputSchema.describe("The Newegg RMA number to edit (must be open)."),
      type: rmaTypeSchema.describe("Must equal the RMA's existing type."),
      note: z.string().min(1).max(4000).describe("RMA comment (required by Newegg), <= 4000."),
      items: z
        .array(writeItemSchema)
        .min(1)
        .max(max)
        .describe(`1-${max} lines; they replace the RMA's lines.`),
      sellerRmaNumber: sellerRmaNumberSchema,
    })
    .describe("The RMA edit to plan.");
}

type EditPreviewSchema = ReturnType<typeof makeEditInputSchema>;

export function createRmaPreviewEditTool(
  config: McpServerConfig,
): ToolDefinition<EditPreviewSchema, typeof servicePreviewOutputSchema> {
  return {
    name: TOOL_NAMES.rmaPreviewEdit,
    title: "Preview editing an RMA",
    description:
      "Plan a Newegg Edit RMA WITHOUT changing anything. Reads the RMA and its order and reports " +
      "BLOCKERS (RMA unknown or not open, type change, quantity/refund above what is returnable, " +
      `refund above the server limit of ${config.limits.maxRefundAmount}) and WARNINGS (lines dropped, ` +
      "the old versus new refund). Only a clean plan gets a single-use previewId for " +
      `newegg_rma_apply_edit. ${MONEY_WARNING} No Newegg mutation happens here.`,
    annotations: previewAnnotations,
    inputSchema: makeEditInputSchema(config),
    outputSchema: servicePreviewOutputSchema,
    handler: (input: z.infer<EditPreviewSchema>, ctx: ToolContext): Promise<ToolResult> =>
      runServicePreview(ctx, "rmaEdit", () => ctx.client.rma.previewEdit(input)),
  };
}

const editApplyInput = applyInputSchema(TOOL_NAMES.rmaPreviewEdit);

export const rmaApplyEditTool: ToolDefinition<
  typeof editApplyInput,
  typeof serviceApplyOutputSchema
> = {
  name: TOOL_NAMES.rmaApplyEdit,
  title: "Apply a previewed RMA edit",
  description:
    "Edit EXACTLY the RMA captured by a previewId from newegg_rma_preview_edit; this changes the " +
    "refund the customer is owed. Accepts only the previewId; single-use. An unknown outcome is " +
    `reported and NOT retried. ${MONEY_WARNING} Exists only when the server is started with writes enabled.`,
  annotations: applyAnnotations,
  inputSchema: editApplyInput,
  outputSchema: serviceApplyOutputSchema,
  handler: (input, ctx) =>
    runServiceApply(ctx, "rmaEdit", input.previewId, async (stored) =>
      serializeRmaResult(await ctx.client.rma.edit(stored)),
    ),
};

// ---------------------------------------------------------------------------
// Process (receive) RMA
// ---------------------------------------------------------------------------
const processInputSchema = z
  .strictObject({
    rmaNumber: numberInputSchema.describe("The Newegg RMA number whose items were received."),
  })
  .describe("The RMA to mark as received.");

export function createRmaPreviewProcessTool(
  config: McpServerConfig,
): ToolDefinition<typeof processInputSchema, typeof servicePreviewOutputSchema> {
  return {
    name: TOOL_NAMES.rmaPreviewProcess,
    title: "Preview receiving an RMA",
    description:
      "Plan a Newegg Process RMA (mark the returned items as received) WITHOUT changing anything. " +
      "Reads the RMA, reports BLOCKERS (RMA unknown or not open, refund above the server limit of " +
      `${config.limits.maxRefundAmount}) and the refund total that receiving a refund RMA is expected ` +
      "to release to the customer. Only a clean plan gets a single-use previewId for " +
      `newegg_rma_apply_process. ${MONEY_WARNING} No Newegg mutation happens here.`,
    annotations: previewAnnotations,
    inputSchema: processInputSchema,
    outputSchema: servicePreviewOutputSchema,
    handler: (input, ctx) =>
      runServicePreview(ctx, "rmaProcess", () => ctx.client.rma.previewProcess(input)),
  };
}

const processApplyInput = applyInputSchema(TOOL_NAMES.rmaPreviewProcess);

export const rmaApplyProcessTool: ToolDefinition<
  typeof processApplyInput,
  typeof serviceApplyOutputSchema
> = {
  name: TOOL_NAMES.rmaApplyProcess,
  title: "Apply a previewed RMA receipt",
  description:
    "Mark EXACTLY the RMA captured by a previewId from newegg_rma_preview_process as received; on a " +
    "refund RMA this releases the refund to the customer. Accepts only the previewId; single-use. An " +
    `unknown outcome is reported and NOT retried. ${MONEY_WARNING} Exists only when the server is started with writes enabled.`,
  annotations: applyAnnotations,
  inputSchema: processApplyInput,
  outputSchema: serviceApplyOutputSchema,
  handler: (input, ctx) =>
    runServiceApply(
      ctx,
      "rmaProcess",
      input.previewId,
      async (stored) => serializeRmaResult(await ctx.client.rma.process(stored)),
      // The refund released is whatever the RMA holds NOW: re-read it and abort if it moved.
      (stored) => ctx.client.rma.previewProcess(stored),
    ),
};

// ---------------------------------------------------------------------------
// Reject RMA
// ---------------------------------------------------------------------------
const rejectInputSchema = z
  .strictObject({
    rmaNumber: numberInputSchema.describe("The Newegg RMA number to reject."),
    reason: z
      .enum([
        "physicalDamage",
        "itemMissing",
        "wrongItemReturned",
        "cpuPinDamage",
        "missingRetailBox",
        "missingUpcCode",
        "tamperedSerialNumber",
        "missingAccessories",
        "consumableItem",
        "motherboardSocketPinDamage",
        "qaSentWrongItem",
        "unlockedCellphone",
        "usedItemReturnedAsNew",
        "customerRequest",
        "missingSerialNumber",
        "software",
      ])
      .describe(
        "Why the returned item is rejected. qaSentWrongItem / unlockedCellphone / usedItemReturnedAsNew are " +
          "Newegg.com and Neweggbusiness.com only; customerRequest / missingSerialNumber / software are Newegg.ca only.",
      ),
    carrier: z
      .enum(["ups", "fedex", "dhl", "usps", "other"])
      .describe("Carrier for the return shipment."),
    otherCarrier: z
      .string()
      .min(1)
      .max(10)
      .optional()
      .describe("Carrier name when carrier is other."),
    shipService: z.string().min(1).max(50).describe("Shipping service, e.g. Ground."),
    trackingNumbers: z.array(z.string().min(1).max(60)).min(1).max(20),
    memo: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe("Rejection memo (required for some reasons)."),
    imageUrls: z.array(z.string().max(2048)).min(1).max(5).optional(),
  })
  .describe("The RMA rejection to plan.");

export function createRmaPreviewRejectTool(
  _config: McpServerConfig,
): ToolDefinition<typeof rejectInputSchema, typeof servicePreviewOutputSchema> {
  return {
    name: TOOL_NAMES.rmaPreviewReject,
    title: "Preview rejecting an RMA",
    description:
      "Plan a Newegg Reject RMA WITHOUT changing anything. Reads the RMA and reports BLOCKERS (RMA " +
      "unknown or not open, reason not available on this marketplace, missing carrier/evidence). " +
      "Rejecting DENIES the customer's return and refund. Only a clean plan gets a single-use previewId " +
      `for newegg_rma_apply_reject. ${MONEY_WARNING} No Newegg mutation happens here.`,
    annotations: previewAnnotations,
    inputSchema: rejectInputSchema,
    outputSchema: servicePreviewOutputSchema,
    handler: (input, ctx) =>
      runServicePreview(ctx, "rmaReject", () => ctx.client.rma.previewReject(input)),
  };
}

const rejectApplyInput = applyInputSchema(TOOL_NAMES.rmaPreviewReject);

export const rmaApplyRejectTool: ToolDefinition<
  typeof rejectApplyInput,
  typeof serviceApplyOutputSchema
> = {
  name: TOOL_NAMES.rmaApplyReject,
  title: "Apply a previewed RMA rejection",
  description:
    "Reject EXACTLY the RMA captured by a previewId from newegg_rma_preview_reject; this denies the " +
    "customer's refund. Accepts only the previewId; single-use. An unknown outcome is reported and NOT " +
    `retried. ${MONEY_WARNING} Exists only when the server is started with writes enabled.`,
  annotations: applyAnnotations,
  inputSchema: rejectApplyInput,
  outputSchema: serviceApplyOutputSchema,
  handler: (input, ctx) =>
    runServiceApply(ctx, "rmaReject", input.previewId, async (stored) =>
      serializeRmaResult(await ctx.client.rma.reject(stored)),
    ),
};
