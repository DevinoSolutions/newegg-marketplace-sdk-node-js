/**
 * Read-only seller / category reference tools: `newegg_seller_status`, `newegg_industries_list`,
 * `newegg_subcategories_list`, `newegg_subcategory_properties` and `newegg_property_values`.
 * They consume only the SDK's public `ReferenceApi` (contracts §19) and register
 * unconditionally (never write-gated): every one is a READ, even where Newegg uses `PUT`.
 *
 * Fields are mapped explicitly (SDK `raw` payloads are never requested). Subcategory and
 * property-value lists can run to thousands of rows, so those tools cap what they return with a
 * `limit` and report the full `totalCount` plus a `truncated` flag.
 */
import { z } from "zod";
import type {
  ListPropertyValuesInput,
  ListSubcategoriesInput,
} from "@devino/newegg-marketplace-sdk";
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
import { TOOL_NAMES } from "./names.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

const subcategoryIdSchema = z.number().int().min(1).describe("A Newegg subcategory id.");
const industryCodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,20}$/, "a Newegg industry code, e.g. AP")
  .describe("A Newegg industry code (see newegg_industries_list).");
const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .optional()
  .describe(`Maximum rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`);

// ---------------------------------------------------------------------------
// newegg_seller_status
// ---------------------------------------------------------------------------
const sellerStatusInputSchema = z.strictObject({}).describe("No input.");

const sellerStatusOutputSchema = z.object({
  marketplace: marketplaceSchema,
  sellerName: z.string().optional(),
  status: z.enum(["active", "suspended", "inactive", "terminated", "closed", "unknown"]),
  statusText: z.string().optional(),
  membership: z.enum(["nonElite", "professional", "enterprise", "unknown"]).optional(),
  fulfillmentCenters: z.array(
    z.object({
      warehouseLocation: z.string().optional(),
      shippedBy: z.enum(["seller", "newegg"]).optional(),
      shipToCountries: z.array(z.string()),
    }),
  ),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function sellerStatusHandler(
  _input: z.infer<typeof sellerStatusInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const status = await ctx.client.reference.getSellerStatus();
    return okResult({
      marketplace: status.marketplace,
      sellerName: status.sellerName,
      status: status.status,
      statusText: status.statusText,
      membership: status.membership,
      fulfillmentCenters: status.fulfillmentCenters.map((center) => ({
        warehouseLocation: center.warehouseLocation,
        shippedBy: center.shippedBy,
        shipToCountries: center.shipToCountries,
      })),
      correlationId: status.correlationId,
      rateLimit: serializeRateLimit(status.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const sellerStatusTool: ToolDefinition<
  typeof sellerStatusInputSchema,
  typeof sellerStatusOutputSchema
> = {
  name: TOOL_NAMES.sellerStatus,
  title: "Get Newegg seller account status",
  description:
    "Seller Status Check: whether the seller account is active, suspended, inactive, terminated " +
    "or closed, plus the store name. On Newegg.com it also returns the membership level and the " +
    "fulfillment centers (warehouse country, ship-by-seller vs ship-by-Newegg, and the countries " +
    "each ships to). Newegg allows 500 requests/hour. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: sellerStatusInputSchema,
  outputSchema: sellerStatusOutputSchema,
  handler: sellerStatusHandler,
};

// ---------------------------------------------------------------------------
// newegg_industries_list
// ---------------------------------------------------------------------------
const industriesInputSchema = z
  .strictObject({
    industryCode: industryCodeSchema
      .optional()
      .describe("Return only this industry; omit for every industry."),
  })
  .describe("Optional industry filter.");

const industriesOutputSchema = z.object({
  marketplace: marketplaceSchema,
  industries: z.array(z.object({ code: z.string(), name: z.string().optional() })),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function industriesHandler(
  input: z.infer<typeof industriesInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await ctx.client.reference.listIndustries(
      input.industryCode !== undefined ? { industryCode: input.industryCode } : {},
    );
    return okResult({
      marketplace: result.marketplace,
      industries: result.industries.map((industry) => ({
        code: industry.code,
        name: industry.name,
      })),
      correlationId: result.correlationId,
      rateLimit: serializeRateLimit(result.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const industriesListTool: ToolDefinition<
  typeof industriesInputSchema,
  typeof industriesOutputSchema
> = {
  name: TOOL_NAMES.industriesList,
  title: "List Newegg industries",
  description:
    "Get Industry List: the industries on Newegg Marketplace (code + name), or one industry by " +
    "code. Industry codes feed newegg_subcategories_list. Newegg allows 10,000 requests/hour. " +
    "Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: industriesInputSchema,
  outputSchema: industriesOutputSchema,
  handler: industriesHandler,
};

// ---------------------------------------------------------------------------
// newegg_subcategories_list
// ---------------------------------------------------------------------------
const subcategoriesInputSchema = z
  .strictObject({
    subcategoryIds: z
      .array(subcategoryIdSchema)
      .min(1)
      .max(200)
      .optional()
      .describe("Restrict to these subcategory ids."),
    industryCodes: z
      .array(industryCodeSchema)
      .min(1)
      .max(200)
      .optional()
      .describe("Restrict to these industry codes."),
    enabled: z
      .boolean()
      .optional()
      .describe("true = only subcategories enabled for the seller, false = only not enabled."),
    countryCode: z
      .string()
      .regex(/^[A-Z]{3}$/, "uppercase ISO 3166-1 alpha-3 code")
      .optional()
      .describe("Check eligibility in this country (Newegg.com only; fails on B2B and Canada)."),
    limit: limitSchema,
  })
  .describe("Optional subcategory-status filters.");

const subcategoriesOutputSchema = z.object({
  marketplace: marketplaceSchema,
  countryCode: z.string().optional(),
  subcategories: z.array(
    z.object({
      industryCode: z.string().optional(),
      industryName: z.string().optional(),
      subcategoryId: z.number(),
      subcategoryName: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
  ),
  totalCount: z.number(),
  truncated: z.boolean(),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function subcategoriesHandler(
  input: z.infer<typeof subcategoriesInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const listInput: ListSubcategoriesInput = {};
  if (input.subcategoryIds !== undefined) listInput.subcategoryIds = input.subcategoryIds;
  if (input.industryCodes !== undefined) listInput.industryCodes = input.industryCodes;
  if (input.enabled !== undefined) listInput.enabled = input.enabled;
  if (input.countryCode !== undefined) listInput.countryCode = input.countryCode;
  const limit = input.limit ?? DEFAULT_LIMIT;
  try {
    const result = await ctx.client.reference.listSubcategories(listInput);
    return okResult({
      marketplace: result.marketplace,
      countryCode: result.countryCode,
      subcategories: result.subcategories.slice(0, limit).map((subcategory) => ({
        industryCode: subcategory.industryCode,
        industryName: subcategory.industryName,
        subcategoryId: subcategory.subcategoryId,
        subcategoryName: subcategory.subcategoryName,
        enabled: subcategory.enabled,
      })),
      totalCount: result.subcategories.length,
      truncated: result.subcategories.length > limit,
      correlationId: result.correlationId,
      rateLimit: serializeRateLimit(result.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const subcategoriesListTool: ToolDefinition<
  typeof subcategoriesInputSchema,
  typeof subcategoriesOutputSchema
> = {
  name: TOOL_NAMES.subcategoriesList,
  title: "List Newegg subcategories and seller eligibility",
  description:
    "Get Subcategory Status: Newegg subcategories (id, name, industry) and whether each is " +
    "enabled for this seller, filterable by subcategory ids, industry codes and enabled state. " +
    "On Newegg.com, countryCode checks eligibility in another country. The full list can be " +
    "large: results are capped at `limit` with totalCount and truncated reported. Subcategory " +
    "ids feed newegg_subcategory_properties. The request budget is shared with the other " +
    "subcategory reads and the live header reports less than the docs state (contracts §19.1). " +
    "Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: subcategoriesInputSchema,
  outputSchema: subcategoriesOutputSchema,
  handler: subcategoriesHandler,
};

// ---------------------------------------------------------------------------
// newegg_subcategory_properties
// ---------------------------------------------------------------------------
const propertiesInputSchema = z
  .strictObject({ subcategoryId: subcategoryIdSchema, limit: limitSchema })
  .describe("The subcategory whose properties to read.");

const propertiesOutputSchema = z.object({
  marketplace: marketplaceSchema,
  subcategoryId: z.number(),
  properties: z.array(
    z.object({
      subcategoryName: z.string().optional(),
      propertyName: z.string(),
      isAdvancedSearch: z.boolean().optional(),
      isGroupBy: z.boolean().optional(),
      isRequired: z.boolean().optional(),
    }),
  ),
  totalCount: z.number(),
  truncated: z.boolean(),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function propertiesHandler(
  input: z.infer<typeof propertiesInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  try {
    const result = await ctx.client.reference.listSubcategoryProperties(input.subcategoryId);
    return okResult({
      marketplace: result.marketplace,
      subcategoryId: result.subcategoryId,
      properties: result.properties.slice(0, limit).map((property) => ({
        subcategoryName: property.subcategoryName,
        propertyName: property.propertyName,
        isAdvancedSearch: property.isAdvancedSearch,
        isGroupBy: property.isGroupBy,
        isRequired: property.isRequired,
      })),
      totalCount: result.properties.length,
      truncated: result.properties.length > limit,
      correlationId: result.correlationId,
      rateLimit: serializeRateLimit(result.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const subcategoryPropertiesTool: ToolDefinition<
  typeof propertiesInputSchema,
  typeof propertiesOutputSchema
> = {
  name: TOOL_NAMES.subcategoryProperties,
  title: "List Newegg subcategory properties",
  description:
    "Get Subcategory Properties: the item properties of one Newegg subcategory (name, and " +
    "whether it is required, a group-by property, or shown in advanced search). Property names " +
    "feed newegg_property_values. The request budget is shared with the other subcategory " +
    "reads and the live header reports less than the docs state (contracts §19.1). Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: propertiesInputSchema,
  outputSchema: propertiesOutputSchema,
  handler: propertiesHandler,
};

// ---------------------------------------------------------------------------
// newegg_property_values
// ---------------------------------------------------------------------------
const propertyValuesInputSchema = z
  .strictObject({
    propertyName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Property name from newegg_subcategory_properties, e.g. Costume_Gender."),
    subcategoryId: subcategoryIdSchema.describe(
      "Subcategory the property belongs to, from newegg_subcategories_list.",
    ),
    limit: limitSchema.describe(
      `Maximum properties returned, and maximum values returned per property (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
    ),
  })
  .describe("The property whose allowed values to read.");

const propertyValuesOutputSchema = z.object({
  marketplace: marketplaceSchema,
  properties: z.array(
    z.object({
      subcategoryId: z.number().optional(),
      subcategoryName: z.string().optional(),
      propertyName: z.string(),
      isAdvancedSearch: z.boolean().optional(),
      isGroupBy: z.boolean().optional(),
      isRequired: z.boolean().optional(),
      values: z.array(z.string()),
      valueCount: z.number(),
      truncated: z.boolean(),
    }),
  ),
  totalCount: z.number(),
  truncated: z.boolean(),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function propertyValuesHandler(
  input: z.infer<typeof propertyValuesInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const listInput: ListPropertyValuesInput = {
    propertyName: input.propertyName,
    subcategoryId: input.subcategoryId,
  };
  const limit = input.limit ?? DEFAULT_LIMIT;
  try {
    const result = await ctx.client.reference.listPropertyValues(listInput);
    return okResult({
      marketplace: result.marketplace,
      properties: result.properties.slice(0, limit).map((property) => ({
        subcategoryId: property.subcategoryId,
        subcategoryName: property.subcategoryName,
        propertyName: property.propertyName,
        isAdvancedSearch: property.isAdvancedSearch,
        isGroupBy: property.isGroupBy,
        isRequired: property.isRequired,
        values: property.values.slice(0, limit),
        valueCount: property.values.length,
        truncated: property.values.length > limit,
      })),
      totalCount: result.properties.length,
      truncated: result.properties.length > limit,
      correlationId: result.correlationId,
      rateLimit: serializeRateLimit(result.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const propertyValuesTool: ToolDefinition<
  typeof propertyValuesInputSchema,
  typeof propertyValuesOutputSchema
> = {
  name: TOOL_NAMES.propertyValues,
  title: "List Newegg property values",
  description:
    "Get Subcategory Property Values: the allowed values of one item property, per subcategory. " +
    "Properties are capped at `limit` (totalCount and truncated reported) and values per property too (valueCount and truncated per property). The " +
    "request budget is shared with the other subcategory reads and the live header reports less " +
    "than the docs state (contracts §19.1). Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: propertyValuesInputSchema,
  outputSchema: propertyValuesOutputSchema,
  handler: propertyValuesHandler,
};
