/**
 * `newegg_feed_result` — fetch the per-record processing report for a FINISHED feed. Records
 * are capped so a huge feed cannot flood the caller; `recordsTruncated` flags the cap.
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
import { TOOL_NAMES } from "./names.js";

const MAX_RECORDS = 500;

const requestIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9]+$/, "requestId must be alphanumeric.")
  .describe("The feed request id whose result to fetch.");

const feedResultInputSchema = z
  .strictObject({ requestId: requestIdSchema })
  .describe("The feed request id to fetch results for.");

const recordSchema = z.object({
  sellerPartNumber: z.string().optional(),
  status: z.enum(["succeeded", "warning", "failed", "unknown"]),
  messages: z.array(z.string()),
  additionalInfo: z.record(z.string(), z.string()),
});

const feedResultOutputSchema = z.object({
  requestId: z.string(),
  status: z.literal("FINISHED"),
  summary: z.object({
    processed: z.number(),
    succeeded: z.number(),
    failed: z.number(),
  }),
  records: z.array(recordSchema),
  recordsTruncated: z.boolean(),
  correlationId: z.string(),
});

async function handler(
  input: z.infer<typeof feedResultInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await ctx.client.feeds.getResult(input.requestId);
    const records = result.records.slice(0, MAX_RECORDS);
    return okResult({
      requestId: result.requestId,
      status: result.status,
      summary: result.summary,
      records: records.map((record) => ({
        sellerPartNumber: record.sellerPartNumber,
        status: record.status,
        messages: record.messages,
        additionalInfo: record.additionalInfo,
      })),
      recordsTruncated: result.records.length > MAX_RECORDS,
      correlationId: result.correlationId,
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const feedResultTool: ToolDefinition<
  typeof feedResultInputSchema,
  typeof feedResultOutputSchema
> = {
  name: TOOL_NAMES.feedResult,
  title: "Get feed result",
  description:
    "Fetch the per-record processing report for a FINISHED Newegg data feed: a processed/" +
    "succeeded/failed summary plus detailed records (Newegg reports the records with errors or " +
    `warnings). At most ${MAX_RECORDS} records are returned; recordsTruncated indicates the cap ` +
    "was hit. A not-finished, cancelled, or invalid request id returns a structured error.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: feedResultInputSchema,
  outputSchema: feedResultOutputSchema,
  handler,
};
