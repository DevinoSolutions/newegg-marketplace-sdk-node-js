import { z } from "zod";
import type { ItemBasicInfoRow } from "@devino/newegg-marketplace-sdk";
import { type ToolDefinition } from "../shared.js";
import { TOOL_NAMES } from "../names.js";
import {
  DEFAULT_LIMIT,
  fileOutput,
  limitSchema,
  reportOutputSchema,
  runReport,
  waitOptions,
  waitSecondsSchema,
} from "./common.js";

// ---------------------------------------------------------------------------
// newegg_reports_daily_inventory
// ---------------------------------------------------------------------------
const dailyInventoryInputSchema = z
  .strictObject({
    fulfillType: z
      .enum(["all", "seller", "newegg"])
      .optional()
      .describe("Fulfillment filter (default all)."),
    warehouses: z
      .array(z.string().regex(/^[A-Z]{3}$/))
      .max(20)
      .optional()
      .describe("US marketplace only: 3-letter ISO warehouse codes (default all)."),
    limit: limitSchema,
    waitSeconds: waitSecondsSchema,
  })
  .describe("Daily Inventory report filters.");

export const reportsDailyInventoryTool: ToolDefinition<
  typeof dailyInventoryInputSchema,
  typeof reportOutputSchema
> = {
  name: TOOL_NAMES.reportsDailyInventory,
  title: "Newegg daily inventory report",
  description:
    "Daily Inventory report: the seller's inventory for every item. US returns per-warehouse " +
    "quantities; Neweggbusiness.com and Newegg.ca return the default warehouse's quantity plus " +
    "currency, MSRP, MAP, selling price, shipping and activation status. The report file is " +
    "downloaded and parsed server-side; the file's credential-bearing download link is never " +
    "exposed. Returns at most `limit` rows plus totalRows. Waits up to waitSeconds; if still " +
    "processing, returns pending=true with a requestId for newegg_reports_status. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: dailyInventoryInputSchema,
  outputSchema: reportOutputSchema,
  handler: (input, ctx) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    return runReport(ctx, async () =>
      fileOutput(
        await ctx.client.reports.dailyInventory.waitForResult(
          {
            ...(input.fulfillType !== undefined ? { fulfillType: input.fulfillType } : {}),
            ...(input.warehouses !== undefined ? { warehouses: input.warehouses } : {}),
          },
          waitOptions(input.waitSeconds, limit),
        ),
        limit,
      ),
    );
  },
};

// ---------------------------------------------------------------------------
// newegg_reports_daily_price
// ---------------------------------------------------------------------------
const dailyPriceInputSchema = z
  .strictObject({
    countries: z
      .array(z.string().regex(/^[A-Z]{3}$/))
      .max(50)
      .optional()
      .describe("3-letter ISO destination countries (default all)."),
    limit: limitSchema,
    waitSeconds: waitSecondsSchema,
  })
  .describe("Daily Price report filters.");

export const reportsDailyPriceTool: ToolDefinition<
  typeof dailyPriceInputSchema,
  typeof reportOutputSchema
> = {
  name: TOOL_NAMES.reportsDailyPrice,
  title: "Newegg daily price report",
  description:
    "Daily Price report (Newegg.com marketplace only; B2B and CAN return an unsupported-operation " +
    "error - use newegg_reports_daily_inventory there): price, MSRP, MAP, shipping and activation " +
    "status per item and destination country. The file is downloaded and parsed server-side; its " +
    "credential-bearing download link is never exposed. Returns at most `limit` rows plus " +
    "totalRows. Waits up to waitSeconds; if still processing, returns pending=true with a " +
    "requestId for newegg_reports_status. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: dailyPriceInputSchema,
  outputSchema: reportOutputSchema,
  handler: (input, ctx) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    return runReport(ctx, async () =>
      fileOutput(
        await ctx.client.reports.dailyPrice.waitForResult(
          input.countries !== undefined ? { countries: input.countries } : {},
          waitOptions(input.waitSeconds, limit),
        ),
        limit,
      ),
    );
  },
};

// ---------------------------------------------------------------------------
// newegg_reports_item_basic_info
// ---------------------------------------------------------------------------
/**
 * Explicit field-by-field mapping: no `extra`, so an unmapped column can never leak. The long
 * bullet description and the image URL list are left out to keep 500-row answers small.
 */
export function serializeItemRow(row: ItemBasicInfoRow): Record<string, unknown> {
  return {
    sellerPartNumber: row.sellerPartNumber,
    neweggItemNumber: row.neweggItemNumber,
    manufacturerPartNumber: row.manufacturerPartNumber,
    upc: row.upc,
    status: row.status,
    active: row.active,
    title: row.title,
    industry: row.industry,
    subcategory: row.subcategory,
    dateCreated: row.dateCreated,
    platform: row.platform,
    itemGroupId: row.itemGroupId,
    varieties: row.varieties,
  };
}

const itemBasicInfoInputSchema = z
  .strictObject({
    status: z
      .enum(["all", "active", "inactive"])
      .optional()
      .describe("Which listings to include (default all)."),
    limit: limitSchema,
    waitSeconds: waitSecondsSchema,
  })
  .describe("Item Basic Information report filters.");

export const reportsItemBasicInfoTool: ToolDefinition<
  typeof itemBasicInfoInputSchema,
  typeof reportOutputSchema
> = {
  name: TOOL_NAMES.reportsItemBasicInfo,
  title: "Newegg item basic information report (all listings)",
  description:
    "Item Basic Information report: every listing of the seller (seller part number / SKU, " +
    "Newegg item number, manufacturer part number, UPC, title, active or inactive, variant " +
    "group). This is the only way to enumerate ALL listings, e.g. to check whether a product " +
    "already has a listing. It carries NO price or stock (use newegg_reports_daily_inventory or " +
    "newegg_inventory_get / newegg_pricing_get for those). " +
    "The report file is downloaded and parsed server-side; its credential-bearing download link " +
    "is never exposed. Returns at most `limit` rows plus totalRows (use `status` to narrow). " +
    "Newegg builds it in about 1-4 minutes: waits up to waitSeconds, else returns pending=true " +
    "with a requestId for newegg_reports_status (reportType itemBasicInfo). Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: itemBasicInfoInputSchema,
  outputSchema: reportOutputSchema,
  handler: (input, ctx) => {
    const limit = input.limit ?? DEFAULT_LIMIT;
    return runReport(ctx, async () =>
      fileOutput(
        await ctx.client.reports.itemBasicInfo.waitForResult(
          input.status !== undefined ? { status: input.status } : {},
          waitOptions(input.waitSeconds, limit),
        ),
        limit,
        serializeItemRow,
      ),
    );
  },
};
