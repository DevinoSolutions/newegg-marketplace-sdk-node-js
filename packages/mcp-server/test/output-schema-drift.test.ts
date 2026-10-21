/**
 * Drift guard: SDK return types vs. MCP tool output schemas.
 *
 * Every output schema is a non-strict zod object, which zod 4 advertises as
 * `additionalProperties: false`, and the MCP client rejects a result whose `structuredContent`
 * does not validate. So when the SDK grows a field two things can happen:
 *   - a handler that passes a nested SDK object straight through (e.g. `order.packages`) starts
 *     emitting a key the schema does not declare and a real host rejects the whole result
 *     (PR #40: SDK `OrderPackage.items`), or
 *   - a handler that maps fields explicitly silently never exposes the new key.
 * Both are "the SDK type has a key the output schema does not cover". This test asks the
 * TypeScript compiler for the keys of the SDK type each tool returns (see
 * `output-schema-drift-lib.ts`) and compares them with the output schema the registered tool
 * advertises over `tools/list`, for the tool set with writes off AND with writes on.
 *
 * To satisfy a failure: add the key to the tool's output schema (and serializer), or list its
 * path in that mapping's `omit` WITH a reason. A newly registered tool must get a TABLE entry or
 * an EXEMPT entry, so the guard cannot be skipped by forgetting it here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeEnv, startHarness, type Harness } from "./helpers.js";
import {
  createSdkTypeProbe,
  type JsonSchemaNode,
  type SdkTypeProbe,
} from "./output-schema-drift-lib.js";

interface Mapping {
  /** Registered MCP tool name. */
  tool: string;
  /** TypeScript type expression for the SDK value the handler maps (`NeweggClient` is in scope). */
  sdk: string;
  /** Where that SDK value sits in the output schema (`order`, `orders[]`, `a.b[]`); default root. */
  schemaPath?: string;
  /** SDK key paths (relative to `sdk`) intentionally NOT exposed, each with the reason. */
  omit?: Record<string, string>;
}

/** `Awaited<ReturnType<NeweggClient["api"]["method"]>>` */
const ret = (api: string, method: string): string =>
  `Awaited<ReturnType<NeweggClient[${JSON.stringify(api)}][${JSON.stringify(method)}]>>`;
/** Same, minus `undefined` (for `tryGet*` methods). */
const retDefined = (api: string, method: string): string => `NonNullable<${ret(api, method)}>`;
/** Element type of an array-valued member of an SDK value. */
const elem = (type: string, key: string): string => `${type}[${JSON.stringify(key)}][number]`;

/** Keys omitted from every tool (`*.key` matches at any depth). */
const GLOBAL_OMIT: Record<string, string> = {
  "*.raw": "SDK raw upstream payloads are never returned to the model (leak + size).",
  "*.correlationId": "Per-call SDK diagnostics; only the envelope level is surfaced where useful.",
  "*.rateLimit": "Per-call SDK diagnostics; only the envelope level is surfaced where useful.",
};

const PII_RMA =
  "PII: customer, notes, memo, issue user and tracking are dropped from RMA output (see rma.ts).";
const PII_REFUND =
  "PII: the customer note and creator/editor names are dropped from refund output (see rma.ts).";
const ROW_OMIT_ADS =
  "Performance rows expose identity + metrics only; group configuration lives in newegg_ads_groups_list.";

const ADS_NOT_EXPOSED =
  "Newegg storefront/landing-page URL metadata; not exposed by this tool. Add it to the schema and " +
  "serializer if a use case appears.";

const FEED_ENVELOPES =
  "Raw feed envelope bodies (the exact submission); `items` carries the structured plan.";

const NORMALIZED_AS_REQUEST = "Returned as `request`, an open record, so it cannot drift.";
const RMA_RECEIPT =
  "The apply output is a write receipt (what was sent); full RMA detail is newegg_rma_get.";
const AT_ENVELOPE_ROOT = "Reported on the envelope root, not inside this sub-object.";

const RMA_APPLY_OMIT: Record<string, string> = {
  note: "PII: RMA notes are never returned.",
  "items[].memo": "PII: RMA item memos are never returned.",
  ...Object.fromEntries(
    [
      "mfrPartNumber",
      "neweggItemNumber",
      "description",
      "unitPrice",
      "shippedBy",
      "reasonCode",
      "reasonDescription",
      "rmaTotalRefund",
      "unopened",
    ].map((key) => [`items[].${key}`, RMA_RECEIPT]),
  ),
};

const reasons = (paths: string[], reason: string): Record<string, string> =>
  Object.fromEntries(paths.map((path) => [path, reason]));

const TABLE: Mapping[] = [
  // ---- reads: inventory / pricing / feeds / service ----
  {
    tool: "newegg_inventory_get",
    sdk: ret("inventory", "getMany"),
    omit: {
      bySellerPartNumber: "Lookup index over `items`; duplicates it.",
      byItemNumber: "Lookup index over `items`; duplicates it.",
      "items[].marketplace": "Reported once on the envelope, not per item.",
    },
  },
  {
    tool: "newegg_pricing_get",
    sdk: ret("pricing", "getMany"),
    omit: {
      bySellerPartNumber: "Lookup index over `items`; duplicates it.",
      byItemNumber: "Lookup index over `items`; duplicates it.",
      "items[].marketplace": "Reported once on the envelope, not per item.",
    },
  },
  { tool: "newegg_feed_status", sdk: ret("feeds", "getStatus") },
  { tool: "newegg_feed_result", sdk: ret("feeds", "getResult") },
  { tool: "newegg_service_status", sdk: ret("service", "getStatus") },

  // ---- reads: orders ----
  { tool: "newegg_orders_list", sdk: ret("orders", "list") },
  { tool: "newegg_orders_get", sdk: retDefined("orders", "tryGet"), schemaPath: "order" },
  {
    tool: "newegg_orders_get_status",
    sdk: retDefined("orders", "tryGetStatus"),
    schemaPath: "orderStatus",
  },
  {
    tool: "newegg_orders_get_additional_info",
    sdk: retDefined("orders", "tryGetAdditionalInfo"),
    schemaPath: "additionalInfo",
  },

  // ---- reads: RMA / refunds ----
  {
    tool: "newegg_rma_list",
    sdk: ret("rma", "list"),
    omit: reasons(
      [
        "rmas[].typeDescription",
        "rmas[].issueUser",
        "rmas[].shipMethod",
        "rmas[].note",
        "rmas[].customer",
        "rmas[].returnLabel",
        "rmas[].items[].reasonCode",
        "rmas[].items[].memo",
      ],
      PII_RMA,
    ),
  },
  {
    tool: "newegg_rma_get",
    sdk: retDefined("rma", "tryGet"),
    schemaPath: "rma",
    omit: reasons(
      [
        "typeDescription",
        "issueUser",
        "shipMethod",
        "note",
        "customer",
        "returnLabel",
        "items[].reasonCode",
        "items[].memo",
      ],
      PII_RMA,
    ),
  },
  {
    tool: "newegg_refund_list",
    sdk: ret("refunds", "list"),
    omit: reasons(
      [
        "refunds[].reasonCode",
        "refunds[].noteToCustomer",
        "refunds[].createdBy",
        "refunds[].editedBy",
      ],
      PII_REFUND,
    ),
  },
  {
    tool: "newegg_refund_status",
    sdk: ret("refunds", "listRequests"),
    omit: {
      ...reasons(
        [
          "requests[].refund.reasonCode",
          "requests[].refund.noteToCustomer",
          "requests[].refund.createdBy",
          "requests[].refund.editedBy",
        ],
        PII_REFUND,
      ),
      "requests[].requestType": "Always the courtesy-refund request type; not informative.",
      "requests[].stateRaw": "Newegg's raw state text; `state` is the normalized form.",
    },
  },

  // ---- reads: reference data ----
  { tool: "newegg_seller_status", sdk: ret("reference", "getSellerStatus") },
  { tool: "newegg_industries_list", sdk: ret("reference", "listIndustries") },
  { tool: "newegg_subcategories_list", sdk: ret("reference", "listSubcategories") },
  {
    tool: "newegg_subcategory_properties",
    sdk: ret("reference", "listSubcategoryProperties"),
    omit: { "properties[].subcategoryId": "Implied by the request's subcategoryId." },
  },
  { tool: "newegg_property_values", sdk: ret("reference", "listPropertyValues") },

  // ---- reads: SBN ----
  { tool: "newegg_sbn_shipments_list", sdk: ret("sbn", "listShipments") },
  { tool: "newegg_sbn_request_status", sdk: ret("sbn", "getRequestStatus") },
  { tool: "newegg_sbn_request_result", sdk: ret("sbn", "getRequestResult") },
  { tool: "newegg_sbn_warehouses_list", sdk: ret("sbn", "listWarehouses") },

  // ---- reads: Sponsored Ads (pages expose rows under a per-tool key) ----
  {
    tool: "newegg_ads_campaigns_list",
    sdk: ret("ads", "listCampaigns"),
    omit: { rows: "Exposed as `campaigns` (row mapping checked next)." },
  },
  {
    tool: "newegg_ads_campaigns_list",
    sdk: elem(ret("ads", "listCampaigns"), "rows"),
    schemaPath: "campaigns[]",
  },
  {
    tool: "newegg_ads_campaign_get",
    sdk: elem(ret("ads", "listCampaigns"), "rows"),
    schemaPath: "campaign",
  },
  {
    tool: "newegg_ads_groups_list",
    sdk: ret("ads", "listGroups"),
    omit: { rows: "Exposed as `groups` (row mapping checked next)." },
  },
  {
    tool: "newegg_ads_groups_list",
    sdk: elem(ret("ads", "listGroups"), "rows"),
    schemaPath: "groups[]",
    omit: reasons(["landingPageType", "landingPageUrl"], ADS_NOT_EXPOSED),
  },
  {
    tool: "newegg_ads_keywords_list",
    sdk: ret("ads", "listKeywords"),
    omit: { rows: "Exposed as `keywords` (row mapping checked next)." },
  },
  {
    tool: "newegg_ads_keywords_list",
    sdk: elem(ret("ads", "listKeywords"), "rows"),
    schemaPath: "keywords[]",
    omit: reasons(["keywordUrl"], ADS_NOT_EXPOSED),
  },
  {
    tool: "newegg_ads_report",
    sdk: ret("ads", "getGroupPerformance"),
    omit: { rows: "Row mappings checked next." },
  },
  {
    tool: "newegg_ads_report",
    sdk: elem(ret("ads", "getGroupPerformance"), "rows"),
    schemaPath: "rows[]",
    omit: reasons(
      [
        "countryCode",
        "defaultBid",
        "offSiteBid",
        "type",
        "keywordCount",
        "productCount",
        "productItemNumbers",
        "createdAt",
        "landingPageType",
        "landingPageUrl",
        "declineReason",
        "costModel",
        "suggBid",
        "suggBidLowest",
        "suggBidMost",
      ],
      ROW_OMIT_ADS,
    ),
  },
  {
    tool: "newegg_ads_report",
    sdk: elem(ret("ads", "getProductPerformance"), "rows"),
    schemaPath: "rows[]",
    omit: reasons(
      [
        "createdAt",
        "countryCode",
        "sellingPrice",
        "sellerPartNumber",
        "itemStatus",
        "declineReason",
      ],
      ROW_OMIT_ADS,
    ),
  },
  {
    tool: "newegg_ads_report",
    sdk: elem(ret("ads", "getKeywordPerformance"), "rows"),
    schemaPath: "rows[]",
    omit: reasons(
      [
        "createdAt",
        "normalizedKeyword",
        "keywordUrl",
        "searchVolume",
        "competition",
        "declineReason",
        "suggBid",
        "suggBidLowest",
        "suggBidMost",
      ],
      ROW_OMIT_ADS,
    ),
  },

  // ---- reads: catalog / reports ----
  { tool: "newegg_catalog_resolve", sdk: ret("catalog", "resolve") },
  {
    tool: "newegg_catalog_lookup_status",
    sdk: ret("catalog", "lookupStatus"),
    omit: { statusRaw: "Newegg's raw status text; `status` is the normalized form." },
  },
  {
    tool: "newegg_catalog_lookup_status",
    sdk: elem(ret("catalog", "lookupResult"), "matches"),
    schemaPath: "matches[]",
  },
  {
    tool: "newegg_reports_status",
    sdk: ret("reports", "status"),
    omit: {
      statusRaw: "Newegg's raw status text; `status` is the normalized form.",
      requestType: "The caller supplies reportType; it is not echoed.",
      totalCount: "Reported as `totalRows` once the report is collected.",
    },
  },

  // ---- reads: shipping label estimate, volume discount ----
  { tool: "newegg_shipping_label_estimate", sdk: ret("shippingLabels", "estimate") },
  { tool: "newegg_volume_discount_get", sdk: retDefined("volumeDiscounts", "tryGet") },

  // ---- writes (registered only with NEWEGG_MCP_ALLOW_WRITES=true) ----
  { tool: "newegg_inventory_apply_update", sdk: ret("inventory", "updateMany") },
  {
    tool: "newegg_pricing_apply_update",
    sdk: ret("pricing", "update"),
    omit: {
      "items[].requestedSellingPrice": "Exposed as `newSellingPrice` (same value, renamed).",
    },
  },
  {
    tool: "newegg_pricing_preview_update",
    sdk: elem(ret("pricing", "previewUpdate"), "changes"),
    schemaPath: "items[]",
    omit: reasons(
      ["active", "map", "msrp", "checkoutMap", "promotions"],
      "Inputs to the preview's blockers/warnings (read the item with newegg_pricing_get); not echoed.",
    ),
  },
  {
    tool: "newegg_listing_apply_create",
    sdk: ret("listings", "create"),
    omit: {
      feeds: "Exposed as `feedJobs` (mapped feed by feed).",
      deduplicatedItemCount: "Always 0 for listing creation (nothing is de-duplicated).",
    },
  },
  {
    tool: "newegg_listing_preview_create",
    sdk: ret("listings", "previewCreate"),
    omit: { envelopes: FEED_ENVELOPES },
  },
  {
    tool: "newegg_volume_discount_apply_update",
    sdk: ret("volumeDiscounts", "update"),
    omit: {
      feeds: "Exposed as `feedJobs` (mapped feed by feed).",
      deduplicatedItemCount: "Always 0 for volume discounts (nothing is de-duplicated).",
    },
  },
  {
    tool: "newegg_volume_discount_preview_update",
    sdk: ret("volumeDiscounts", "previewUpdate"),
    omit: { envelopes: FEED_ENVELOPES },
  },

  // ---- writes: RMA / refund / shipping label (shared service-write envelopes) ----
  {
    tool: "newegg_rma_preview_submit",
    sdk: ret("rma", "previewSubmit"),
    omit: { normalized: NORMALIZED_AS_REQUEST },
  },
  {
    tool: "newegg_rma_preview_edit",
    sdk: ret("rma", "previewEdit"),
    omit: { normalized: NORMALIZED_AS_REQUEST },
  },
  {
    tool: "newegg_rma_preview_process",
    sdk: ret("rma", "previewProcess"),
    omit: { normalized: NORMALIZED_AS_REQUEST },
  },
  {
    tool: "newegg_rma_preview_reject",
    sdk: ret("rma", "previewReject"),
    omit: { normalized: NORMALIZED_AS_REQUEST },
  },
  {
    tool: "newegg_rma_apply_submit",
    sdk: ret("rma", "submit"),
    schemaPath: "rma",
    omit: {
      ...reasons(["marketplace", "operation", "currency"], AT_ENVELOPE_ROOT),
      ...RMA_APPLY_OMIT,
    },
  },
  {
    tool: "newegg_rma_apply_edit",
    sdk: ret("rma", "edit"),
    schemaPath: "rma",
    omit: {
      ...reasons(["marketplace", "operation", "currency"], AT_ENVELOPE_ROOT),
      ...RMA_APPLY_OMIT,
    },
  },
  {
    tool: "newegg_rma_apply_process",
    sdk: ret("rma", "process"),
    schemaPath: "rma",
    omit: {
      ...reasons(["marketplace", "operation", "currency"], AT_ENVELOPE_ROOT),
      ...RMA_APPLY_OMIT,
    },
  },
  {
    tool: "newegg_rma_apply_reject",
    sdk: ret("rma", "reject"),
    schemaPath: "rma",
    omit: {
      ...reasons(["marketplace", "operation", "currency"], AT_ENVELOPE_ROOT),
      ...RMA_APPLY_OMIT,
    },
  },
  {
    tool: "newegg_refund_preview_issue",
    sdk: ret("refunds", "previewIssue"),
    omit: { normalized: NORMALIZED_AS_REQUEST },
  },
  {
    tool: "newegg_refund_apply_issue",
    sdk: ret("refunds", "issue"),
    schemaPath: "courtesyRefund",
    omit: {
      ...reasons(["marketplace", "currency"], AT_ENVELOPE_ROOT),
      memo: "Free-text memo from the caller's request; not echoed.",
    },
  },
  {
    tool: "newegg_shipping_label_preview_create",
    sdk: ret("shippingLabels", "previewCreate"),
    omit: { normalized: NORMALIZED_AS_REQUEST },
  },
  {
    tool: "newegg_shipping_label_preview_reprint",
    sdk: ret("shippingLabels", "previewReprint"),
    omit: { normalized: NORMALIZED_AS_REQUEST },
  },
  { tool: "newegg_shipping_label_apply_create", sdk: ret("shippingLabels", "create") },
  { tool: "newegg_shipping_label_apply_reprint", sdk: ret("shippingLabels", "reprint") },
];

/**
 * Tools whose output is assembled by the handler (computed counts, policy blockers, a stored
 * preview id) rather than mapped from one SDK return value, so there is no SDK type to compare.
 * Each reason says what keeps the output schema honest instead.
 */
const EXEMPT: Record<string, string> = {
  newegg_inventory_preview_update:
    "Envelope is computed in the handler (counts, previewId, planned-item rows from NormalizedInventoryUpdate); " +
    "the result schema is shared with newegg_inventory_apply_update, which IS checked against SDK updateMany.",
  newegg_reports_settlement_summary:
    "Rows are an open record by design; the envelope is built by pagedOutput().",
  newegg_reports_settlement_transactions:
    "Rows are an open record by design; the envelope is built by pagedOutput().",
  newegg_reports_daily_inventory:
    "Rows are an open record by design; the envelope is built by fileOutput().",
  newegg_reports_daily_price:
    "Rows are an open record by design; the envelope is built by fileOutput().",
  newegg_reports_item_basic_info:
    "Rows are an open record by design (explicit PII-free mapper); the envelope is built by fileOutput().",
  newegg_reports_order_list:
    "Rows are an open record by design (explicit PII-free mapper); the envelope is built by pagedOutput().",
  newegg_reports_rma_list:
    "Rows are an open record by design (explicit PII-free mapper); the envelope is built by pagedOutput().",
};

interface ListedTool {
  name: string;
  outputSchema?: unknown;
}

const MODES = [
  { label: "writes off", writes: "false" },
  { label: "writes on", writes: "true" },
] as const;

describe("MCP output schemas cover the SDK types the handlers return", () => {
  const listings = new Map<string, ListedTool[]>();
  let probe: SdkTypeProbe;

  beforeAll(async () => {
    for (const mode of MODES) {
      const harness: Harness = await startHarness({
        env: makeEnv({ NEWEGG_MCP_ALLOW_WRITES: mode.writes }),
      });
      try {
        listings.set(mode.label, (await harness.mcp.listTools()).tools);
      } finally {
        await harness.close();
      }
    }
    probe = createSdkTypeProbe(TABLE.map((mapping) => mapping.sdk));
  }, 120_000);

  afterAll(() => {
    listings.clear();
  });

  it("type-checks every SDK type expression in the table", () => {
    expect(probe.diagnostics()).toEqual([]);
  });

  it("accounts for every registered tool (mapped or exempt) and has no stale entries", () => {
    const registered = new Set(
      MODES.flatMap((mode) => (listings.get(mode.label) ?? []).map((tool) => tool.name)),
    );
    const accounted = new Set([...TABLE.map((mapping) => mapping.tool), ...Object.keys(EXEMPT)]);
    expect([...registered].filter((name) => !accounted.has(name)).sort()).toEqual([]);
    expect([...accounted].filter((name) => !registered.has(name)).sort()).toEqual([]);
    expect(Object.keys(EXEMPT).filter((name) => TABLE.some((m) => m.tool === name))).toEqual([]);
  });

  it("every omit entry carries a reason", () => {
    const blank = [GLOBAL_OMIT, ...TABLE.map((mapping) => mapping.omit ?? {})].flatMap((omit) =>
      Object.entries(omit)
        .filter(([, reason]) => reason.trim() === "")
        .map(([path]) => path),
    );
    expect(blank).toEqual([]);
  });

  for (const mode of MODES) {
    it(`every tool advertises an object output schema (${mode.label})`, () => {
      const tools = listings.get(mode.label) ?? [];
      expect(tools.length).toBeGreaterThan(0);
      const missing = tools.filter(
        (tool) => (tool.outputSchema as JsonSchemaNode | undefined)?.type !== "object",
      );
      expect(missing.map((tool) => tool.name)).toEqual([]);
    });

    it(`no SDK key is missing from an output schema (${mode.label})`, () => {
      const tools = new Map((listings.get(mode.label) ?? []).map((tool) => [tool.name, tool]));
      const failures: string[] = [];
      for (const mapping of TABLE) {
        const tool = tools.get(mapping.tool);
        if (tool === undefined) continue; // a write tool, absent with writes off
        const omitted = new Set([...Object.keys(GLOBAL_OMIT), ...Object.keys(mapping.omit ?? {})]);
        const findings = probe.check(
          mapping.sdk,
          tool.outputSchema as JsonSchemaNode,
          mapping.schemaPath ?? "",
          omitted,
        );
        for (const finding of findings) {
          const where = mapping.schemaPath === undefined ? "" : `${mapping.schemaPath} -> `;
          failures.push(
            `${mapping.tool}: SDK key "${where}${finding.path}" (${finding.sdkOwner}) is not in the ` +
              `output schema. Add it to the schema and serializer, or list it in the mapping's ` +
              `omit with a reason.`,
          );
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
