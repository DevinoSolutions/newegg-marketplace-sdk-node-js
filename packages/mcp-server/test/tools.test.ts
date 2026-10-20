import { describe, expect, it } from "vitest";
import {
  callTool,
  inventoryListRoute,
  makeEnv,
  serviceStatusRoute,
  startHarness,
} from "./helpers.js";

interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { type?: string; additionalProperties?: unknown };
  outputSchema?: { type?: string };
  annotations?: { title?: string; readOnlyHint?: boolean };
}

async function listTools(env?: Record<string, string | undefined>): Promise<ListedTool[]> {
  const harness = await startHarness({ env });
  try {
    const result = (await harness.mcp.listTools()) as { tools: ListedTool[] };
    return result.tools;
  } finally {
    await harness.close();
  }
}

describe("tools/list", () => {
  it("exposes exactly the 42 read tools when writes are disabled", async () => {
    const tools = await listTools(makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "false" }));
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "newegg_catalog_lookup_status",
        "newegg_ads_campaign_get",
        "newegg_ads_campaigns_list",
        "newegg_ads_groups_list",
        "newegg_ads_keywords_list",
        "newegg_ads_report",
        "newegg_catalog_resolve",
        "newegg_feed_result",
        "newegg_feed_status",
        "newegg_industries_list",
        "newegg_inventory_get",
        "newegg_inventory_preview_update",
        "newegg_listing_preview_create",
        "newegg_orders_get",
        "newegg_orders_get_additional_info",
        "newegg_orders_get_status",
        "newegg_orders_list",
        "newegg_pricing_get",
        "newegg_property_values",
        "newegg_refund_list",
        "newegg_refund_status",
        "newegg_reports_daily_inventory",
        "newegg_reports_daily_price",
        "newegg_reports_item_basic_info",
        "newegg_reports_order_list",
        "newegg_reports_rma_list",
        "newegg_reports_settlement_summary",
        "newegg_reports_settlement_transactions",
        "newegg_reports_status",
        "newegg_rma_get",
        "newegg_rma_list",
        "newegg_sbn_request_result",
        "newegg_sbn_request_status",
        "newegg_sbn_shipments_list",
        "newegg_sbn_warehouses_list",
        "newegg_seller_status",
        "newegg_shipping_label_estimate",
        "newegg_service_status",
        "newegg_subcategories_list",
        "newegg_volume_discount_get",
        "newegg_volume_discount_preview_update",
        "newegg_subcategory_properties",
      ].sort(),
    );
    expect(names).not.toContain("newegg_inventory_apply_update");
    expect(names).not.toContain("newegg_listing_apply_create");
    expect(names).not.toContain("newegg_volume_discount_apply_update");
    expect(names).not.toContain("newegg_pricing_preview_update");
    expect(names).not.toContain("newegg_pricing_apply_update");
    expect(
      names.filter((name) => /_(preview|apply)_(submit|edit|process|reject|issue)$/.test(name)),
    ).toEqual([]);
  });

  it("adds the write tools when writes are enabled (61 tools)", async () => {
    const tools = await listTools(makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true" }));
    const names = tools.map((tool) => tool.name);
    expect(names).toHaveLength(61);
    expect(names).toContain("newegg_inventory_apply_update");
    expect(names).toContain("newegg_listing_apply_create");
    expect(names).toContain("newegg_volume_discount_apply_update");
    expect(names).toContain("newegg_pricing_preview_update");
    expect(names).toContain("newegg_pricing_apply_update");
    // RMA / courtesy-refund writes (contracts §20): a preview and an apply tool per operation.
    for (const operation of ["submit", "edit", "process", "reject"]) {
      expect(names).toContain(`newegg_rma_preview_${operation}`);
      expect(names).toContain(`newegg_rma_apply_${operation}`);
    }
    expect(names).toContain("newegg_refund_preview_issue");
    expect(names).toContain("newegg_refund_apply_issue");
  });

  it("gives every tool a title, description, inputSchema, and outputSchema", async () => {
    const tools = await listTools(makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true" }));
    for (const tool of tools) {
      const title = tool.title ?? tool.annotations?.title;
      expect(title, `${tool.name} title`).toBeTruthy();
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeDefined();
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
    }
  });
});

describe("strict input schemas", () => {
  it("rejects an unknown key in newegg_inventory_get args", async () => {
    const harness = await startHarness({ routes: [inventoryListRoute()] });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_get", {
        identifiers: [{ type: "sellerPartNumber", value: "A" }],
        surprise: true,
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("rejects credential-like keys smuggled into any tool args", async () => {
    const harness = await startHarness({ routes: [inventoryListRoute()] });
    try {
      for (const badKey of ["apiKey", "secretKey", "baseUrl", "overwrite"]) {
        const res = await callTool(harness.mcp, "newegg_inventory_get", {
          identifiers: [{ type: "sellerPartNumber", value: "A" }],
          [badKey]: "x",
        });
        expect(res.isError, `${badKey} should be rejected`).toBe(true);
      }
    } finally {
      await harness.close();
    }
  });

  it("rejects an invalid identifier type", async () => {
    const harness = await startHarness({ routes: [inventoryListRoute()] });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_get", {
        identifiers: [{ type: "notARealType", value: "A" }],
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("rejects a preview with more updates than the configured max", async () => {
    const harness = await startHarness({
      env: makeEnv({ NEWEGG_MCP_MAX_ITEMS_PER_OPERATION: "2", NEWEGG_MCP_ALLOW_WRITES: "true" }),
    });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: [
          { identifier: { type: "sellerPartNumber", value: "A" }, quantity: 1 },
          { identifier: { type: "sellerPartNumber", value: "B" }, quantity: 2 },
          { identifier: { type: "sellerPartNumber", value: "C" }, quantity: 3 },
        ],
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_inventory_get", () => {
  it("reads inventory and never leaks SDK raw", async () => {
    const harness = await startHarness({ routes: [inventoryListRoute({ A: 9, B: 4 })] });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_get", {
        identifiers: [
          { type: "sellerPartNumber", value: "A" },
          { type: "sellerPartNumber", value: "B" },
        ],
      });
      expect(res.isError).toBe(false);
      expect(res.structuredContent).toBeDefined();
      expect(res.structuredContent).toEqual(res.json);
      expect(res.json.marketplace).toBe("ca");
      const items = res.json.items as Array<{
        sellerPartNumber?: string;
        totalAvailableQuantity: number;
      }>;
      expect(items).toHaveLength(2);
      expect(items.map((item) => item.totalAvailableQuantity).sort()).toEqual([4, 9]);
      expect(res.text).not.toContain("raw");
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_service_status", () => {
  it("reports availability from a wrapped response", async () => {
    const harness = await startHarness({ routes: [serviceStatusRoute("1")] });
    try {
      const res = await callTool(harness.mcp, "newegg_service_status", {});
      expect(res.isError).toBe(false);
      expect(res.json.available).toBe(true);
      expect(res.json.domain).toBe("contentmgmt");
    } finally {
      await harness.close();
    }
  });

  it("reports unavailability with a message", async () => {
    const harness = await startHarness({
      routes: [serviceStatusRoute("0", "Down for maintenance")],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_service_status", { domain: "datafeedmgmt" });
      expect(res.json.available).toBe(false);
      expect(res.json.domain).toBe("datafeedmgmt");
      expect(res.json.message).toBe("Down for maintenance");
    } finally {
      await harness.close();
    }
  });
});
