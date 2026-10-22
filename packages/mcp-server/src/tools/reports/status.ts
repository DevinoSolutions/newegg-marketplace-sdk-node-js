import { z } from "zod";
import type { NeweggClient } from "@devino/newegg-marketplace-sdk";
import { serializeRma } from "../rma.js";
import {
  errorResult,
  mapErrorToPayload,
  marketplaceSchema,
  okResult,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "../shared.js";
import { TOOL_NAMES } from "../names.js";
import {
  currencyOf,
  DEFAULT_LIMIT,
  fileOutput,
  limitSchema,
  pagedOutput,
  rowSchema,
  waitOptions,
} from "./common.js";
import { serializeItemRow } from "./file-reports.js";
import { serializeOrderRow } from "./order-list.js";

// ---------------------------------------------------------------------------
// newegg_reports_status
// ---------------------------------------------------------------------------
const REPORT_TYPES = [
  "settlementSummary",
  "settlementTransactions",
  "dailyInventory",
  "dailyPrice",
  "itemBasicInfo",
  "orderList",
  "rmaList",
] as const;

const statusInputSchema = z
  .strictObject({
    requestId: z
      .string()
      .min(1)
      .max(64)
      .describe("The requestId returned (pending) by a newegg_reports_* tool."),
    reportType: z.enum(REPORT_TYPES).describe("Which report the requestId belongs to."),
    limit: limitSchema,
  })
  .describe("A pending report to check.");

const statusOutputSchema = z.object({
  marketplace: marketplaceSchema,
  requestId: z.string(),
  status: z.enum(["submitted", "inProgress", "finished", "cancelled", "unknown"]),
  rows: z.array(rowSchema).optional(),
  totalRows: z.number().optional(),
  returnedRows: z.number().optional(),
  truncated: z.boolean().optional(),
  fileName: z.string().optional(),
  currency: z.enum(["USD", "CAD"]).optional(),
});

async function collectFinished(
  client: NeweggClient,
  input: z.infer<typeof statusInputSchema>,
  limit: number,
): Promise<Record<string, unknown>> {
  const options = waitOptions(5, limit);
  switch (input.reportType) {
    case "settlementSummary":
      return pagedOutput(
        await client.reports.settlementSummary.waitForRequest(input.requestId, options),
        limit,
      );
    case "settlementTransactions":
      return pagedOutput(
        await client.reports.settlementTransactions.waitForRequest(input.requestId, options),
        limit,
      );
    case "dailyInventory":
      return fileOutput(
        await client.reports.dailyInventory.waitForRequest(input.requestId, options),
        limit,
      );
    case "dailyPrice":
      return fileOutput(
        await client.reports.dailyPrice.waitForRequest(input.requestId, options),
        limit,
      );
    case "itemBasicInfo":
      return fileOutput(
        await client.reports.itemBasicInfo.waitForRequest(input.requestId, options),
        limit,
        serializeItemRow,
      );
    case "orderList":
      return {
        ...pagedOutput(
          await client.reports.orderList.waitForRequest(input.requestId, options),
          limit,
          serializeOrderRow,
        ),
        currency: currencyOf(client),
      };
    case "rmaList":
      return {
        ...pagedOutput(
          await client.reports.rmaList.waitForRequest(input.requestId, options),
          limit,
          serializeRma,
        ),
        currency: currencyOf(client),
      };
  }
}

async function statusHandler(
  input: z.infer<typeof statusInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const status = await ctx.client.reports.status(input.requestId);
    if (status.status !== "finished") {
      return okResult({
        marketplace: status.marketplace,
        requestId: status.requestId,
        status: status.status,
      });
    }
    const output = await collectFinished(ctx.client, input, input.limit ?? DEFAULT_LIMIT);
    const { pending: _pending, ...rest } = output;
    return okResult({ ...rest, status: "finished" });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const reportsStatusTool: ToolDefinition<
  typeof statusInputSchema,
  typeof statusOutputSchema
> = {
  name: TOOL_NAMES.reportsStatus,
  title: "Check a pending Newegg report",
  description:
    "Check a pending report started by a newegg_reports_* tool (pass its requestId and the same " +
    "reportType). When finished, returns the report rows (up to `limit`, plus totalRows); " +
    "otherwise returns the current status - wait a few seconds and call again. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: statusInputSchema,
  outputSchema: statusOutputSchema,
  handler: statusHandler,
};
