/**
 * Read-only catalog-resolution tools: `newegg_catalog_resolve` and
 * `newegg_catalog_lookup_status`. Both consume only the SDK's public `CatalogApi` —
 * report submission is a READ (it creates a report job and mutates nothing on the seller
 * account; contracts §12.4) — plus `inventory.tryGetItem` for the `alreadyListed` flag.
 * They register unconditionally (independent of write-gating). The name→identifier gap
 * is the CALLER's job: the tools take identifiers only, per the descriptions.
 */
import { z } from "zod";
import { CatalogLookupTimeoutError } from "@devino/newegg-marketplace-sdk";
import type { CatalogLookupInput, CatalogMatch } from "@devino/newegg-marketplace-sdk";
import {
  conditionSchema,
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
import { TOOL_NAMES } from "./names.js";

/** `alreadyListed` is checked for at most this many distinct item numbers per call — each
 * check is a live inventory read with its own rate budget. */
const ALREADY_LISTED_CHECK_LIMIT = 5;

/** Default bounded wait before returning pending (seconds). */
const DEFAULT_WAIT_SECONDS = 55;

// ---------------------------------------------------------------------------
// shared schemas
// ---------------------------------------------------------------------------
const lookupItemSchema = z
  .strictObject({
    upc: z.string().min(6).max(14).optional().describe("UPC/EAN/GTIN digits."),
    manufacturer: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Manufacturer/brand name (required together with manufacturerPartNumber)."),
    manufacturerPartNumber: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Manufacturer part number (MPN; required together with manufacturer)."),
    neweggItemNumber: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .describe("A Newegg item number (e.g. 9SIA…) — passed through as already resolved."),
    condition: conditionSchema.optional().describe("Item condition filter (default: any)."),
  })
  .refine(
    (item) => {
      const hasUpc = item.upc !== undefined;
      const hasMpnPart =
        item.manufacturer !== undefined || item.manufacturerPartNumber !== undefined;
      const hasItemNumber = item.neweggItemNumber !== undefined;
      const families = [hasUpc, hasMpnPart, hasItemNumber].filter(Boolean).length;
      if (families !== 1) return false;
      if (hasMpnPart) {
        return item.manufacturer !== undefined && item.manufacturerPartNumber !== undefined;
      }
      return true;
    },
    {
      message:
        "Provide exactly one identifier family per item: upc, OR manufacturer AND " +
        "manufacturerPartNumber (both), OR neweggItemNumber.",
    },
  );

const matchOutputSchema = z.object({
  neweggItemNumber: z.string(),
  upc: z.string().optional(),
  condition: conditionSchema.optional(),
  packsOrSets: z.number().optional(),
  manufacturer: z.string().optional(),
  manufacturerPartNumber: z.string().optional(),
  websiteShortTitle: z
    .string()
    .optional()
    .describe("Newegg's catalog title — verify it matches the intended product."),
  alreadyListed: z
    .boolean()
    .optional()
    .describe("true when this seller already has an offer on this item."),
});

function toLookupInput(item: z.infer<typeof lookupItemSchema>): CatalogLookupInput {
  if (item.neweggItemNumber !== undefined) {
    return { neweggItemNumber: item.neweggItemNumber };
  }
  if (item.upc !== undefined) {
    return item.condition !== undefined
      ? { upc: item.upc, condition: item.condition }
      : { upc: item.upc };
  }
  // The refine guarantees both fields are present on this branch.
  const manufacturer = item.manufacturer ?? "";
  const manufacturerPartNumber = item.manufacturerPartNumber ?? "";
  return item.condition !== undefined
    ? { manufacturer, manufacturerPartNumber, condition: item.condition }
    : { manufacturer, manufacturerPartNumber };
}

/** Serializes a match, attaching `alreadyListed` from the lookup cache when known. */
function serializeMatch(
  match: CatalogMatch,
  alreadyListed: Map<string, boolean>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { neweggItemNumber: match.neweggItemNumber };
  if (match.upc !== undefined) out.upc = match.upc;
  if (match.condition !== undefined) out.condition = match.condition;
  if (match.packsOrSets !== undefined) out.packsOrSets = match.packsOrSets;
  if (match.manufacturer !== undefined) out.manufacturer = match.manufacturer;
  if (match.manufacturerPartNumber !== undefined) {
    out.manufacturerPartNumber = match.manufacturerPartNumber;
  }
  if (match.websiteShortTitle !== undefined) out.websiteShortTitle = match.websiteShortTitle;
  const listed = alreadyListed.get(match.neweggItemNumber);
  if (listed !== undefined) out.alreadyListed = listed;
  return out;
}

/** Best-effort `alreadyListed` enrichment: a failed inventory read never fails the call. */
async function checkAlreadyListed(
  ctx: ToolContext,
  itemNumbers: string[],
): Promise<Map<string, boolean>> {
  const listed = new Map<string, boolean>();
  for (const value of itemNumbers.slice(0, ALREADY_LISTED_CHECK_LIMIT)) {
    try {
      const snapshot = await ctx.client.inventory.tryGetItem({
        identifier: { type: "neweggItemNumber", value },
      });
      listed.set(value, snapshot !== undefined);
    } catch {
      // Enrichment only — resolution results stand on their own.
    }
  }
  return listed;
}

// ---------------------------------------------------------------------------
// newegg_catalog_resolve
// ---------------------------------------------------------------------------
const resolveInputSchema = z
  .strictObject({
    items: z
      .array(lookupItemSchema)
      .min(1)
      .max(20)
      .describe("Products to resolve (max 20 per call)."),
    waitSeconds: z
      .number()
      .int()
      .min(5)
      .max(115)
      .optional()
      .describe(
        "How long to wait for the async lookup report before returning pending (default 55).",
      ),
  })
  .describe("Identifiers to resolve against Newegg's catalog.");

const resolutionOutputSchema = z.object({
  input: z.record(z.string(), z.unknown()),
  found: z.boolean(),
  matches: z.array(matchOutputSchema),
});

const resolveOutputSchema = z.object({
  marketplace: marketplaceSchema,
  pending: z.boolean(),
  requestId: z.string().optional(),
  resolutions: z.array(resolutionOutputSchema).optional(),
  message: z.string().optional(),
});

async function resolveHandler(
  input: z.infer<typeof resolveInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const inputs = input.items.map(toLookupInput);
  const waitMs = (input.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
  try {
    const result = await ctx.client.catalog.resolve(inputs, { timeoutMs: waitMs });
    const uniqueItemNumbers = [
      ...new Set(result.resolutions.flatMap((r) => r.matches.map((m) => m.neweggItemNumber))),
    ];
    const alreadyListed = await checkAlreadyListed(ctx, uniqueItemNumbers);
    return okResult({
      marketplace: result.marketplace,
      pending: false,
      requestId: result.requestId,
      resolutions: result.resolutions.map((r) => ({
        input: r.input,
        found: r.found,
        matches: r.matches.map((m) => serializeMatch(m, alreadyListed)),
      })),
    });
  } catch (error) {
    if (error instanceof CatalogLookupTimeoutError && error.retryable) {
      return okResult({
        marketplace: ctx.client.marketplace,
        pending: true,
        requestId: error.requestId,
        message:
          "The lookup report is still processing at Newegg. Call newegg_catalog_lookup_status " +
          "with this requestId (do NOT resubmit — submissions are limited to 100/hour).",
      });
    }
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const catalogResolveTool: ToolDefinition<
  typeof resolveInputSchema,
  typeof resolveOutputSchema
> = {
  name: TOOL_NAMES.catalogResolve,
  title: "Resolve products to Newegg item numbers",
  description:
    "Resolve products to their Newegg catalog item numbers (NeweggItemNumber) so a listing can " +
    "later be created against the right catalog item. Accepts, per item: a UPC, OR " +
    "manufacturer+manufacturerPartNumber (MPN), OR an existing neweggItemNumber (passed through). " +
    "IMPORTANT: Newegg cannot search by product name — if you only have a name (e.g. 'Corsair " +
    "MP700 Micro 2TB'), first determine its UPC or manufacturer+MPN (from your own knowledge, " +
    "the user, or a web search), then call this tool with those identifiers; verify the returned " +
    "websiteShortTitle matches the intended product. Runs an async Newegg lookup report and " +
    "waits up to waitSeconds; if still processing, returns pending=true with a requestId for " +
    "newegg_catalog_lookup_status. Matches include alreadyListed=true when this seller already " +
    "has an offer on that item. Read-only: never creates or changes a listing.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: resolveInputSchema,
  outputSchema: resolveOutputSchema,
  handler: resolveHandler,
};

// ---------------------------------------------------------------------------
// newegg_catalog_lookup_status
// ---------------------------------------------------------------------------
const statusInputSchema = z
  .strictObject({
    requestId: z
      .string()
      .min(1)
      .max(64)
      .describe("The lookup requestId returned by newegg_catalog_resolve."),
  })
  .describe("A pending catalog-lookup report to check.");

const statusOutputSchema = z.object({
  marketplace: marketplaceSchema,
  requestId: z.string(),
  status: z.enum(["submitted", "inProgress", "finished", "cancelled", "unknown"]),
  matches: z.array(matchOutputSchema).optional(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function statusHandler(
  input: z.infer<typeof statusInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const status = await ctx.client.catalog.lookupStatus(input.requestId);
    if (status.status !== "finished") {
      return okResult({
        marketplace: status.marketplace,
        requestId: status.requestId,
        status: status.status,
        rateLimit: serializeRateLimit(status.rateLimit),
      });
    }
    const matches: CatalogMatch[] = [];
    let page = 1;
    for (;;) {
      const result = await ctx.client.catalog.lookupResult(input.requestId, page);
      matches.push(...result.matches);
      if (page >= result.totalPageCount) break;
      page += 1;
    }
    const alreadyListed = await checkAlreadyListed(ctx, [
      ...new Set(matches.map((m) => m.neweggItemNumber)),
    ]);
    return okResult({
      marketplace: status.marketplace,
      requestId: status.requestId,
      status: "finished",
      matches: matches.map((m) => serializeMatch(m, alreadyListed)),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const catalogLookupStatusTool: ToolDefinition<
  typeof statusInputSchema,
  typeof statusOutputSchema
> = {
  name: TOOL_NAMES.catalogLookupStatus,
  title: "Check a pending Newegg catalog lookup",
  description:
    "Check a pending catalog-lookup report started by newegg_catalog_resolve. When finished, " +
    "returns all catalog matches (NeweggItemNumber, UPC, MPN, title, alreadyListed); otherwise " +
    "returns the current status — wait a few seconds and call again. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: statusInputSchema,
  outputSchema: statusOutputSchema,
  handler: statusHandler,
};
