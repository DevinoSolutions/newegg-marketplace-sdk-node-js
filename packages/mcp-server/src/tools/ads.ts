/**
 * Read-only Sponsored Ads tools: `newegg_ads_campaigns_list`, `newegg_ads_campaign_get`,
 * `newegg_ads_groups_list`, `newegg_ads_keywords_list` and `newegg_ads_report`. They
 * consume only the SDK's public `AdsApi` (contracts §25) and register unconditionally (never
 * write-gated): every one is a READ, although Newegg uses `POST` for all of them. Creating or
 * changing campaigns, groups, products, keywords and targeting spends money and is not exposed.
 * Newegg.com only; on Business and Canada each tool returns the SDK's `unsupported_operation`
 * error.
 *
 * Fields are mapped explicitly (SDK `raw` payloads are never requested).
 */
import { z } from "zod";
import type {
  AdsCampaign,
  AdsGroupPerformance,
  AdsKeywordPerformance,
  AdsPage,
  AdsProductPerformance,
  GetAdsGroupPerformanceInput,
  ListAdsCampaignsInput,
  ListAdsGroupsInput,
  ListAdsKeywordsInput,
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

// ---------------------------------------------------------------------------
// shared schemas + helpers
// ---------------------------------------------------------------------------
/** Highest page index accepted (mirrors the SDK's ADS_PAGE_MAX sanity bound). */
const PAGE_MAX = 10_000;

/** True for a real calendar day, so `2026-13-45` and `2026-02-30` are refused. */
function isCalendarDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

const dayString = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
    .refine(isCalendarDay, "must be a real calendar date, YYYY-MM-DD")
    .describe(`${what} (YYYY-MM-DD).`);

const pageSchema = z
  .number()
  .int()
  .min(1)
  .max(PAGE_MAX)
  .optional()
  .describe(`1-based page index (default 1, max ${PAGE_MAX}).`);

/** Refuses a date range whose start falls after its end (both already valid days). */
function checkDateOrder(
  value: { fromDate?: string | undefined; toDate?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.fromDate !== undefined && value.toDate !== undefined && value.fromDate > value.toDate) {
    ctx.addIssue({ code: "custom", path: ["fromDate"], message: "must not be after toDate" });
  }
}

const campaignNumberSchema = z
  .number()
  .int()
  .positive()
  .describe("Newegg campaign number (an integer identifier).");

const groupNumberSchema = z
  .number()
  .int()
  .positive()
  .describe("Newegg ad group number (an integer identifier).");

const activeStatusSchema = z
  .enum(["active", "inactive"])
  .optional()
  .describe("active = Processing / Delivering / Out of budget; inactive = Inactive / Ended.");

const sortOrderSchema = z
  .enum(["asc", "desc"])
  .optional()
  .describe("Sort direction (default desc).");

const nameOrNumberSchema = z
  .enum(["name", "number"])
  .optional()
  .describe("What `keyword` matches: a text name (fuzzy, default) or identifier number(s).");

/** Free-text detail from Newegg; bounded so it cannot flood tool output. */
function clip(text: string | undefined, max = 300): string | undefined {
  return text !== undefined && text.length > max ? `${text.slice(0, max)}...` : text;
}

const pageOutput = {
  marketplace: marketplaceSchema,
  totalRows: z.number(),
  page: z.number().optional(),
  pageSize: z.number().optional(),
  message: z.string().optional(),
  bizCode: z.string().optional(),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
};

function pageFields<T>(result: AdsPage<T>) {
  return {
    marketplace: result.marketplace,
    totalRows: result.totalRows,
    page: result.page,
    pageSize: result.pageSize,
    message: clip(result.message),
    bizCode: clip(result.bizCode, 40),
    correlationId: result.correlationId,
    rateLimit: serializeRateLimit(result.rateLimit),
  };
}

const campaignRowSchema = z.strictObject({
  campaignNumber: z.number(),
  name: z.string().optional(),
  countryCode: z.string().optional(),
  type: z.number().optional(),
  activeStatus: z.string().optional(),
  status: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  budget: z.number().optional(),
  dailyBudget: z.number().optional(),
  groupCount: z.number().optional(),
  createdAt: z.string().optional(),
  lastEditedAt: z.string().optional(),
  displayType: z.string().optional(),
  declineReason: z.string().optional(),
  costModel: z.number().optional(),
});

function serializeCampaign(c: AdsCampaign): z.infer<typeof campaignRowSchema> {
  return {
    campaignNumber: c.campaignNumber,
    name: c.name,
    countryCode: c.countryCode,
    type: c.type,
    activeStatus: c.activeStatus,
    status: c.status,
    startDate: c.startDate,
    endDate: c.endDate,
    budget: c.budget,
    dailyBudget: c.dailyBudget,
    groupCount: c.groupCount,
    createdAt: c.createdAt,
    lastEditedAt: c.lastEditedAt,
    displayType: c.displayType,
    declineReason: clip(c.declineReason),
    costModel: c.costModel,
  };
}

// ---------------------------------------------------------------------------
// newegg_ads_campaigns_list
// ---------------------------------------------------------------------------
const campaignsListInputSchema = z
  .strictObject({
    keyword: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Campaign name, or number(s) per searchBy."),
    searchBy: nameOrNumberSchema,
    activeStatus: activeStatusSchema,
    type: z
      .number()
      .int()
      .min(0)
      .max(8)
      .optional()
      .describe("0 manual targeting, 1 auto targeting."),
    sponsorType: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe("0 Sponsored Products, 1 Headlines, 2 Video, 3 Display, 4 Offsite Ads."),
    fromDate: dayString("Campaign start filter").optional(),
    toDate: dayString("Campaign end filter").optional(),
    page: pageSchema,
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Page size, max 100 (default 100)."),
    sortField: z
      .string()
      .regex(/^[A-Za-z]{1,40}$/)
      .optional()
      .describe("Field to sort by (default InDate)."),
    sortOrder: sortOrderSchema,
  })
  .superRefine(checkDateOrder)
  .describe("Sponsored Ads campaign list criteria; all fields optional.");

const campaignsListOutputSchema = z.object({
  ...pageOutput,
  campaigns: z.array(campaignRowSchema),
});

function toCampaignInput(input: z.infer<typeof campaignsListInputSchema>): ListAdsCampaignsInput {
  const out: ListAdsCampaignsInput = {};
  if (input.keyword !== undefined) out.keyword = input.keyword;
  if (input.searchBy !== undefined) out.searchBy = input.searchBy;
  if (input.activeStatus !== undefined) out.activeStatus = input.activeStatus;
  if (input.type !== undefined) out.type = input.type;
  if (input.sponsorType !== undefined) out.sponsorType = input.sponsorType;
  if (input.fromDate !== undefined) out.fromDate = input.fromDate;
  if (input.toDate !== undefined) out.toDate = input.toDate;
  if (input.page !== undefined) out.page = input.page;
  if (input.pageSize !== undefined) out.pageSize = input.pageSize;
  if (input.sortField !== undefined) out.sortField = input.sortField;
  if (input.sortOrder !== undefined) out.sortOrder = input.sortOrder;
  return out;
}

async function campaignsListHandler(
  input: z.infer<typeof campaignsListInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await ctx.client.ads.listCampaigns(toCampaignInput(input));
    return okResult({
      ...pageFields(result),
      campaigns: result.rows.map(serializeCampaign),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const adsCampaignsListTool: ToolDefinition<
  typeof campaignsListInputSchema,
  typeof campaignsListOutputSchema
> = {
  name: TOOL_NAMES.adsCampaignsList,
  title: "List Sponsored Ads campaigns",
  description:
    "Campaign List: the seller's Newegg Sponsored Ads campaigns (number, name, type, status, " +
    "budget, daily budget, group count), filterable by name or number, status, type, sponsor type " +
    "and date range. Newegg.com only. Newegg allows 1,000 requests/hour. Read-only; it never " +
    "creates, changes or pauses a campaign.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: campaignsListInputSchema,
  outputSchema: campaignsListOutputSchema,
  handler: campaignsListHandler,
};

// ---------------------------------------------------------------------------
// newegg_ads_campaign_get
// ---------------------------------------------------------------------------
const campaignGetInputSchema = z
  .strictObject({ campaignNumber: campaignNumberSchema })
  .describe("The campaign to look up.");

const campaignGetOutputSchema = z.object({
  marketplace: marketplaceSchema,
  found: z.boolean(),
  campaign: campaignRowSchema.optional(),
  correlationId: z.string(),
  rateLimit: rateLimitOutputSchema.optional(),
});

async function campaignGetHandler(
  input: z.infer<typeof campaignGetInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await ctx.client.ads.listCampaigns({
      keyword: String(input.campaignNumber),
      searchBy: "number",
      pageSize: 100,
    });
    const campaign = result.rows.find((c) => c.campaignNumber === input.campaignNumber);
    return okResult({
      marketplace: result.marketplace,
      found: campaign !== undefined,
      campaign: campaign === undefined ? undefined : serializeCampaign(campaign),
      correlationId: result.correlationId,
      rateLimit: serializeRateLimit(result.rateLimit),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const adsCampaignGetTool: ToolDefinition<
  typeof campaignGetInputSchema,
  typeof campaignGetOutputSchema
> = {
  name: TOOL_NAMES.adsCampaignGet,
  title: "Get a Sponsored Ads campaign",
  description:
    "Looks up one Sponsored Ads campaign by number (a Campaign List search by campaign number). " +
    "Returns found=false when the account has no such campaign. Newegg.com only. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: campaignGetInputSchema,
  outputSchema: campaignGetOutputSchema,
  handler: campaignGetHandler,
};

// ---------------------------------------------------------------------------
// newegg_ads_groups_list
// ---------------------------------------------------------------------------
const groupsListInputSchema = z
  .strictObject({
    campaignNumber: campaignNumberSchema,
    keyword: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Group name, or number(s) per searchBy."),
    searchBy: nameOrNumberSchema,
    activeStatus: activeStatusSchema,
    page: pageSchema,
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Page size, max 100 (default 100)."),
    sortField: z
      .string()
      .regex(/^[A-Za-z]{1,40}$/)
      .optional()
      .describe("Field to sort by (default InDate)."),
    sortOrder: sortOrderSchema,
  })
  .describe("Ad group list criteria for one campaign.");

const groupsListOutputSchema = z.object({
  ...pageOutput,
  groups: z.array(
    z.object({
      campaignNumber: z.number().optional(),
      campaignName: z.string().optional(),
      groupNumber: z.number(),
      groupName: z.string().optional(),
      countryCode: z.string().optional(),
      defaultBid: z.number().optional(),
      offSiteBid: z.number().optional(),
      type: z.number().optional(),
      suggBid: z.number().optional(),
      suggBidLowest: z.number().optional(),
      suggBidMost: z.number().optional(),
      keywordCount: z.number().optional(),
      productCount: z.number().optional(),
      productItemNumbers: z.array(z.string()),
      activeStatus: z.string().optional(),
      status: z.string().optional(),
      createdAt: z.string().optional(),
      declineReason: z.string().optional(),
      costModel: z.number().optional(),
    }),
  ),
});

async function groupsListHandler(
  input: z.infer<typeof groupsListInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const listInput: ListAdsGroupsInput = { campaignNumber: input.campaignNumber };
  if (input.keyword !== undefined) listInput.keyword = input.keyword;
  if (input.searchBy !== undefined) listInput.searchBy = input.searchBy;
  if (input.activeStatus !== undefined) listInput.activeStatus = input.activeStatus;
  if (input.page !== undefined) listInput.page = input.page;
  if (input.pageSize !== undefined) listInput.pageSize = input.pageSize;
  if (input.sortField !== undefined) listInput.sortField = input.sortField;
  if (input.sortOrder !== undefined) listInput.sortOrder = input.sortOrder;
  try {
    const result = await ctx.client.ads.listGroups(listInput);
    return okResult({
      ...pageFields(result),
      groups: result.rows.map((g) => ({
        campaignNumber: g.campaignNumber,
        campaignName: g.campaignName,
        groupNumber: g.groupNumber,
        groupName: g.groupName,
        countryCode: g.countryCode,
        defaultBid: g.defaultBid,
        offSiteBid: g.offSiteBid,
        type: g.type,
        suggBid: g.suggBid,
        suggBidLowest: g.suggBidLowest,
        suggBidMost: g.suggBidMost,
        keywordCount: g.keywordCount,
        productCount: g.productCount,
        productItemNumbers: g.productItemNumbers,
        activeStatus: g.activeStatus,
        status: g.status,
        createdAt: g.createdAt,
        declineReason: clip(g.declineReason),
        costModel: g.costModel,
      })),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const adsGroupsListTool: ToolDefinition<
  typeof groupsListInputSchema,
  typeof groupsListOutputSchema
> = {
  name: TOOL_NAMES.adsGroupsList,
  title: "List Sponsored Ads ad groups",
  description:
    "Group List: the ad groups of one Sponsored Ads campaign (number, name, default bid, keyword " +
    "and product counts, item numbers, status), filterable by name or number and status. " +
    "Newegg.com only. Newegg allows 1,000 requests/hour. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: groupsListInputSchema,
  outputSchema: groupsListOutputSchema,
  handler: groupsListHandler,
};

// ---------------------------------------------------------------------------
// newegg_ads_keywords_list
// ---------------------------------------------------------------------------
const keywordsListInputSchema = z
  .strictObject({
    campaignNumber: campaignNumberSchema,
    groupNumber: groupNumberSchema.optional(),
    keyword: z.string().min(1).max(200).optional().describe("Keyword text to match (fuzzy)."),
    activeStatus: activeStatusSchema,
    page: pageSchema,
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Page size, max 1000 here (default 100)."),
    sortField: z
      .string()
      .regex(/^[A-Za-z]{1,40}$/)
      .optional()
      .describe("Field to sort by (default InDate)."),
    sortOrder: sortOrderSchema,
  })
  .describe("Keyword list criteria for one campaign (optionally one ad group).");

const keywordsListOutputSchema = z.object({
  ...pageOutput,
  keywords: z.array(
    z.object({
      campaignNumber: z.number().optional(),
      campaignName: z.string().optional(),
      groupNumber: z.number().optional(),
      groupName: z.string().optional(),
      keyword: z.string(),
      matchType: z.number().optional(),
      normalizedKeyword: z.string().optional(),
      suggBid: z.number().optional(),
      suggBidLowest: z.number().optional(),
      suggBidMost: z.number().optional(),
      searchVolume: z.string().optional(),
      competition: z.string().optional(),
      bid: z.number().optional(),
      activeStatus: z.string().optional(),
      status: z.string().optional(),
      declineReason: z.string().optional(),
    }),
  ),
});

async function keywordsListHandler(
  input: z.infer<typeof keywordsListInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const listInput: ListAdsKeywordsInput = { campaignNumber: input.campaignNumber };
  if (input.groupNumber !== undefined) listInput.groupNumber = input.groupNumber;
  if (input.keyword !== undefined) listInput.keyword = input.keyword;
  if (input.activeStatus !== undefined) listInput.activeStatus = input.activeStatus;
  if (input.page !== undefined) listInput.page = input.page;
  if (input.pageSize !== undefined) listInput.pageSize = input.pageSize;
  if (input.sortField !== undefined) listInput.sortField = input.sortField;
  if (input.sortOrder !== undefined) listInput.sortOrder = input.sortOrder;
  try {
    const result = await ctx.client.ads.listKeywords(listInput);
    return okResult({
      ...pageFields(result),
      keywords: result.rows.map((k) => ({
        campaignNumber: k.campaignNumber,
        campaignName: k.campaignName,
        groupNumber: k.groupNumber,
        groupName: k.groupName,
        keyword: k.keyword,
        matchType: k.matchType,
        normalizedKeyword: k.normalizedKeyword,
        suggBid: k.suggBid,
        suggBidLowest: k.suggBidLowest,
        suggBidMost: k.suggBidMost,
        searchVolume: k.searchVolume,
        competition: k.competition,
        bid: k.bid,
        activeStatus: k.activeStatus,
        status: k.status,
        declineReason: clip(k.declineReason),
      })),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const adsKeywordsListTool: ToolDefinition<
  typeof keywordsListInputSchema,
  typeof keywordsListOutputSchema
> = {
  name: TOOL_NAMES.adsKeywordsList,
  title: "List Sponsored Ads keywords",
  description:
    "Keywords List: the keywords of a Sponsored Ads campaign or ad group with match type (0 exact, " +
    "1 broad, 6 phrase), bid, suggested bids, competition and status. Newegg.com only. Newegg " +
    "allows 1,000 requests/hour. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: keywordsListInputSchema,
  outputSchema: keywordsListOutputSchema,
  handler: keywordsListHandler,
};

// ---------------------------------------------------------------------------
// newegg_ads_report
// ---------------------------------------------------------------------------
const performanceInputSchema = z
  .strictObject({
    level: z
      .enum(["group", "product", "keyword"])
      .describe(
        "Which report: group (per ad group; campaignNumber optional), product or keyword (both " +
          "need campaignNumber and groupNumber).",
      ),
    fromDate: dayString("Start of the reporting range"),
    toDate: dayString("End of the reporting range"),
    campaignNumber: campaignNumberSchema.optional(),
    groupNumber: groupNumberSchema.optional(),
    keyword: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Group name filter (group level), item filter (product) or keyword text (keyword).",
      ),
    activeStatus: activeStatusSchema,
    page: pageSchema,
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Page size, max 1000 here (default 100; group level caps at 100)."),
    sortField: z
      .string()
      .regex(/^[A-Za-z]{1,40}$/)
      .optional()
      .describe("Field to sort by (default InDate)."),
    sortOrder: sortOrderSchema,
  })
  .superRefine(checkDateOrder)
  .describe("Synchronous Sponsored Ads performance report criteria.");

const metricFields = {
  spend: z.number().optional(),
  sales: z.number().optional(),
  acos: z.number().optional(),
  impressions: z.number().optional(),
  clicks: z.number().optional(),
  ctr: z.number().optional(),
  orders: z.number().optional(),
  cr: z.number().optional(),
  cpc: z.number().optional(),
};

const performanceOutputSchema = z.object({
  ...pageOutput,
  level: z.enum(["group", "product", "keyword"]),
  rows: z.array(
    z.strictObject({
      campaignNumber: z.number().optional(),
      campaignName: z.string().optional(),
      groupNumber: z.number().optional(),
      groupName: z.string().optional(),
      itemNumber: z.string().optional(),
      itemTitle: z.string().optional(),
      keyword: z.string().optional(),
      matchType: z.number().optional(),
      bid: z.number().optional(),
      activeStatus: z.string().optional(),
      status: z.string().optional(),
      ...metricFields,
    }),
  ),
});

type PerformanceRow = AdsGroupPerformance | AdsProductPerformance | AdsKeywordPerformance;

function serializePerformanceRow(row: PerformanceRow) {
  return {
    campaignNumber: row.campaignNumber,
    campaignName: row.campaignName,
    groupNumber: row.groupNumber,
    groupName: row.groupName,
    itemNumber: "itemNumber" in row ? row.itemNumber : undefined,
    itemTitle: "itemTitle" in row ? row.itemTitle : undefined,
    keyword: "keyword" in row ? row.keyword : undefined,
    matchType: "matchType" in row ? row.matchType : undefined,
    bid: "bid" in row ? row.bid : undefined,
    activeStatus: row.activeStatus,
    status: row.status,
    spend: row.spend,
    sales: row.sales,
    acos: row.acos,
    impressions: row.impressions,
    clicks: row.clicks,
    ctr: row.ctr,
    orders: row.orders,
    cr: row.cr,
    cpc: row.cpc,
  };
}

function failInput(message: string, ctx: ToolContext): ToolResult {
  return errorResult(mapErrorToPayload(new Error(message), ctx.logger));
}

async function performanceHandler(
  input: z.infer<typeof performanceInputSchema>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const range = { fromDate: input.fromDate, toDate: input.toDate };
  const paging: Pick<GetAdsGroupPerformanceInput, "page" | "pageSize" | "sortField" | "sortOrder"> =
    {};
  if (input.page !== undefined) paging.page = input.page;
  if (input.pageSize !== undefined) paging.pageSize = input.pageSize;
  if (input.sortField !== undefined) paging.sortField = input.sortField;
  if (input.sortOrder !== undefined) paging.sortOrder = input.sortOrder;
  try {
    if (input.level === "group") {
      const groupInput: GetAdsGroupPerformanceInput = { ...range, ...paging };
      if (input.campaignNumber !== undefined) groupInput.campaignNumber = input.campaignNumber;
      if (input.keyword !== undefined) groupInput.keyword = input.keyword;
      if (input.activeStatus !== undefined) groupInput.activeStatus = input.activeStatus;
      const result = await ctx.client.ads.getGroupPerformance(groupInput);
      return okResult({
        ...pageFields(result),
        level: "group",
        rows: result.rows.map(serializePerformanceRow),
      });
    }
    if (input.campaignNumber === undefined || input.groupNumber === undefined) {
      return failInput(
        `The ${input.level} performance report needs campaignNumber and groupNumber.`,
        ctx,
      );
    }
    const base = {
      ...range,
      ...paging,
      campaignNumber: input.campaignNumber,
      groupNumber: input.groupNumber,
      ...(input.keyword !== undefined ? { keyword: input.keyword } : {}),
      ...(input.activeStatus !== undefined ? { activeStatus: input.activeStatus } : {}),
    };
    if (input.level === "product") {
      const result = await ctx.client.ads.getProductPerformance(base);
      return okResult({
        ...pageFields(result),
        level: "product",
        rows: result.rows.map(serializePerformanceRow),
      });
    }
    const result = await ctx.client.ads.getKeywordPerformance(base);
    return okResult({
      ...pageFields(result),
      level: "keyword",
      rows: result.rows.map(serializePerformanceRow),
    });
  } catch (error) {
    return errorResult(mapErrorToPayload(error, ctx.logger));
  }
}

export const adsPerformanceReportTool: ToolDefinition<
  typeof performanceInputSchema,
  typeof performanceOutputSchema
> = {
  name: TOOL_NAMES.adsPerformanceReport,
  title: "Sponsored Ads performance report",
  description:
    "Group, Product or Keywords Performance Report: spend, sales, ACoS, impressions, clicks, CTR, " +
    "orders, conversion rate and CPC over a date range (YYYY-MM-DD). The group report covers a " +
    "campaign (or all); the product and keyword reports cover one ad group. Synchronous " +
    "(no report job). Newegg.com only. Newegg allows 1,000 requests/hour. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: performanceInputSchema,
  outputSchema: performanceOutputSchema,
  handler: performanceHandler,
};
