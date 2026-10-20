/**
 * `newegg_shipping_label_estimate`: the Shipping Label Service quote (contracts §23). The page
 * documents it as "for estimation only", so it is registered unconditionally like every read; it
 * consumes only the SDK's public `ShippingLabelsApi.estimate`. Buying or reprinting a label is a
 * WRITE and lives in `shipping-label-write.ts` behind `NEWEGG_MCP_ALLOW_WRITES=true`.
 *
 * The input schema defined here is shared with the label purchase preview so both describe the
 * same request.
 */
import { z } from "zod";
import {
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
import { TOOL_NAMES } from "./names.js";

const timestampSchema = z.object({ raw: z.string(), iso: z.string().optional() });

const shipFromSchema = z.strictObject({
  firstName: z.string().min(1).max(50),
  lastName: z.string().min(1).max(50),
  phoneNumber: z.string().min(7).max(25),
  address1: z.string().min(1).max(100),
  address2: z.string().max(100).optional(),
  city: z.string().min(1).max(60),
  stateCode: z.string().min(2).max(3).describe("Two-letter state or province code."),
  zipCode: z.string().min(3).max(10).describe("US ZIP or Canadian postal code."),
  countryCode: z
    .enum(["USA", "CAN"])
    .optional()
    .describe("ISO alpha-3; defaults to the marketplace's country."),
});

const packageSchema = z.strictObject({
  weightLb: z.number().positive().max(150).describe("Package weight in pounds (UPS max 150)."),
  lengthIn: z.number().positive().max(108).describe("Longest side in inches (UPS max 108)."),
  widthIn: z.number().positive().max(108).describe("Width in inches."),
  heightIn: z.number().positive().max(108).describe("Height in inches."),
  signatureRequired: z
    .boolean()
    .optional()
    .describe("Require the recipient's signature (adds a carrier surcharge)."),
  items: z
    .array(
      z.strictObject({
        sellerPartNumber: z.string().min(1).max(60),
        quantity: z.number().int().positive().max(9999),
      }),
    )
    .min(1)
    .max(100)
    .describe("Order lines in this package; each line's whole ordered quantity must ship."),
});

/** The label request shared by the estimate tool and the purchase preview. */
export const shippingLabelRequestSchema = z.strictObject({
  orderNumber: numberInputSchema.describe("The Newegg order (shipped by the seller, unshipped)."),
  serviceCode: z
    .number()
    .int()
    .min(100)
    .max(120)
    .optional()
    .describe(
      "UPS service code. Newegg.com / Business: 101 Ground, 102 3 Day Select, 103 2nd Day Air, " +
        "104 Next Day Air Saver, 105 Next Day Air. Newegg.ca: 111 Standard, 112 Express, 113 " +
        "Expedited, 114 Express Saver. Omit to use the service the customer bought.",
    ),
  shipFrom: shipFromSchema,
  packages: z.array(packageSchema).min(1).max(20),
});

const rateSchema = z.object({
  shipWeight: z.number().optional(),
  arriveBy: timestampSchema.optional(),
  shippingAmount: z.number().optional(),
  signatureAmount: z.number().optional(),
  total: z.number().optional(),
});

const estimateOutputSchema = z.object({
  marketplace: marketplaceSchema,
  orderNumber: z.string(),
  estimatedDate: timestampSchema.optional(),
  currency: z.enum(["USD", "CAD"]),
  packages: z.array(
    z.object({
      succeeded: z.boolean(),
      errorMessage: z.string().optional(),
      weightLb: z.number().optional(),
      lengthIn: z.number().optional(),
      widthIn: z.number().optional(),
      heightIn: z.number().optional(),
      signatureRequired: z.boolean(),
      rate: rateSchema.optional(),
    }),
  ),
  estimatedTotal: z.number(),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function estimateHandler(
  input: z.infer<typeof shippingLabelRequestSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await ctx.client.shippingLabels.estimate(input);
    return okResult({
      marketplace: result.marketplace,
      orderNumber: result.orderNumber,
      estimatedDate: result.estimatedDate,
      currency: result.currency,
      packages: result.packages,
      estimatedTotal: result.estimatedTotal,
      correlationId: result.correlationId,
      rateLimit: serializeRateLimit(result.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const shippingLabelEstimateTool: ToolDefinition<
  typeof shippingLabelRequestSchema,
  typeof estimateOutputSchema
> = {
  name: TOOL_NAMES.shippingLabelEstimate,
  title: "Estimate a UPS shipping label",
  description:
    "Shipping Label Estimate Request: quote the UPS charge (shipping amount, signature surcharge, " +
    "total, arrival date) for the packages of an order WITHOUT buying a label. Newegg documents it " +
    "as estimation only; that is unverified live. Use it before newegg_shipping_label_preview_create " +
    "(which needs writes enabled). Newegg allows 1,000 requests/hour. The label itself cannot be " +
    "obtained from this tool.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: shippingLabelRequestSchema,
  outputSchema: estimateOutputSchema,
  handler: estimateHandler,
};
