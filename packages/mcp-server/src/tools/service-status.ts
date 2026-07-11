/**
 * `newegg_service_status` — report Newegg service availability for a documented domain.
 */
import { z } from "zod";
import type { NeweggServiceDomain } from "@devino/newegg-marketplace-sdk";
import {
  errorResult,
  mapErrorToPayload,
  marketplaceSchema,
  okResult,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./shared.js";
import { TOOL_NAMES } from "./names.js";

const domainSchema = z.enum([
  "contentmgmt",
  "ordermgmt",
  "datafeedmgmt",
  "servicemgmt",
  "reportmgmt",
  "sellermgmt",
  "sbnmgmt",
  "shippingservice",
]);

export const serviceStatusInputSchema = z
  .strictObject({
    domain: domainSchema.optional().describe("Service domain to query; defaults to contentmgmt."),
  })
  .describe("Optional service domain to check.");

const serviceStatusOutputSchema = z.object({
  marketplace: marketplaceSchema,
  domain: domainSchema,
  available: z.boolean(),
  timestamp: z.object({ raw: z.string(), iso: z.string().optional() }).optional(),
  message: z.string().optional(),
  correlationId: z.string(),
});

async function handler(
  input: z.infer<typeof serviceStatusInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const domain: NeweggServiceDomain | undefined = input.domain;
  try {
    const status = await ctx.client.service.getStatus(domain);
    return okResult({
      marketplace: status.marketplace,
      domain: status.domain,
      available: status.available,
      timestamp: status.timestamp,
      message: status.message,
      correlationId: status.correlationId,
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const serviceStatusTool: ToolDefinition<
  typeof serviceStatusInputSchema,
  typeof serviceStatusOutputSchema
> = {
  name: TOOL_NAMES.serviceStatus,
  title: "Get Newegg service status",
  description:
    "Report whether a Newegg Marketplace service domain (contentmgmt, ordermgmt, datafeedmgmt, " +
    "servicemgmt, reportmgmt, sellermgmt, sbnmgmt, or shippingservice) is currently available. " +
    "Defaults to contentmgmt. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: serviceStatusInputSchema,
  outputSchema: serviceStatusOutputSchema,
  handler,
};
