/**
 * `newegg_feed_status` — poll the processing status of a submitted data feed by request id.
 */
import { z } from "zod";
import {
  errorResult,
  mapErrorToPayload,
  okResult,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./shared.js";
import { feedRequestStatusSchema } from "./operation-result.js";
import { TOOL_NAMES } from "./names.js";

const requestIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9]+$/, "requestId must be alphanumeric.")
  .describe("The feed request id returned by an apply/feed submission.");

export const feedStatusInputSchema = z
  .strictObject({ requestId: requestIdSchema })
  .describe("The feed request id to check.");

const submittedAtSchema = z.object({ raw: z.string(), iso: z.string().optional() });

const feedStatusOutputSchema = z.object({
  requestId: z.string(),
  status: feedRequestStatusSchema,
  requestType: z.string().optional(),
  submittedAt: submittedAtSchema.optional(),
  correlationId: z.string(),
});

async function handler(
  input: z.infer<typeof feedStatusInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const report = await ctx.client.feeds.getStatus(input.requestId);
    return okResult({
      requestId: report.requestId,
      status: report.status,
      requestType: report.requestType,
      submittedAt: report.submittedAt,
      correlationId: report.correlationId,
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const feedStatusTool: ToolDefinition<
  typeof feedStatusInputSchema,
  typeof feedStatusOutputSchema
> = {
  name: TOOL_NAMES.feedStatus,
  title: "Get feed status",
  description:
    "Check the processing status of a previously submitted Newegg data feed by its request id " +
    "(SUBMITTED, IN_PROGRESS, FINISHED, CANCELLED, or UNKNOWN). Read-only. Use after an apply " +
    "that returned feed jobs; once FINISHED, fetch newegg_feed_result for per-record detail.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: feedStatusInputSchema,
  outputSchema: feedStatusOutputSchema,
  handler,
};
