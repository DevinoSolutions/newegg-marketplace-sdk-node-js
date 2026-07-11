import { describe, expect, it } from "vitest";
import { loadMcpConfigFromEnv } from "../src/index.js";
import { callTool, inventoryAndPriceRoute, makeEnv, startHarness } from "./helpers.js";

const writesEnv = (overrides: Record<string, string | undefined> = {}) =>
  makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true", ...overrides });

function updates(count: number, quantityStart = 1): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    identifier: { type: "sellerPartNumber", value: `SKU-${index}` },
    quantity: quantityStart + index,
  }));
}

describe("newegg_inventory_preview_update", () => {
  it("returns a previewId + ISO expiry and matching structured/text output", async () => {
    const harness = await startHarness({ env: writesEnv() });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: [
          { identifier: { type: "sellerPartNumber", value: "A" }, quantity: 5 },
          { identifier: { type: "sellerPartNumber", value: "B" }, quantity: 0 },
        ],
      });
      expect(res.isError).toBe(false);
      expect(res.json.mode).toBe("preview");
      expect(typeof res.json.previewId).toBe("string");
      expect((res.json.previewId as string).length).toBeGreaterThan(20);
      const expiry = res.json.previewExpiresAt as string;
      expect(new Date(expiry).toISOString()).toBe(expiry);
      // structuredContent and the text fallback are byte-identical after JSON.
      expect(res.structuredContent).toEqual(res.json);
      const items = res.json.items as Array<{ status: string }>;
      expect(items.every((item) => item.status === "planned")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("surfaces zero-quantity updates prominently in warnings (even when allowed)", async () => {
    const harness = await startHarness({ env: writesEnv() });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: [
          { identifier: { type: "sellerPartNumber", value: "A" }, quantity: 5 },
          { identifier: { type: "sellerPartNumber", value: "B" }, quantity: 0 },
        ],
      });
      const warnings = res.json.warnings as string[];
      expect(warnings.some((w) => w.includes("quantity to 0"))).toBe(true);
      expect(warnings.some((w) => w.includes("index(es): 1"))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("counts de-duplicated updates (last-write-wins) and resolves a small batch to direct", async () => {
    const harness = await startHarness({ env: writesEnv() });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: [
          { identifier: { type: "sellerPartNumber", value: "A" }, quantity: 5 },
          { identifier: { type: "sellerPartNumber", value: "A" }, quantity: 9 },
        ],
      });
      expect(res.json.deduplicatedItemCount).toBe(1);
      expect((res.json.items as unknown[]).length).toBe(1);
      expect(res.json.strategy).toBe("direct");
    } finally {
      await harness.close();
    }
  });

  it("resolves a large batch to feed and warns about async submission", async () => {
    const harness = await startHarness({ env: writesEnv() });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: updates(9),
      });
      expect(res.json.strategy).toBe("feed");
      const warnings = res.json.warnings as string[];
      expect(warnings.some((w) => w.includes("data feed"))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("does not perform any Newegg call during preview", async () => {
    const harness = await startHarness({ env: writesEnv(), routes: [inventoryAndPriceRoute()] });
    try {
      await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: [{ identifier: { type: "sellerPartNumber", value: "A" }, quantity: 5 }],
      });
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_inventory_apply_update", () => {
  it("applies exactly the previewed quantities via the direct path (tamper-proof)", async () => {
    const harness = await startHarness({ env: writesEnv(), routes: [inventoryAndPriceRoute()] });
    try {
      const preview = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: [{ identifier: { type: "sellerPartNumber", value: "A" }, quantity: 42 }],
      });
      const previewId = preview.json.previewId as string;

      const apply = await callTool(harness.mcp, "newegg_inventory_apply_update", { previewId });
      expect(apply.isError).toBe(false);
      expect(apply.json.mode).toBe("apply");
      expect(apply.json.acceptedItemCount).toBe(1);
      const items = apply.json.items as Array<{ status: string }>;
      expect(items[0]?.status).toBe("succeeded");

      // The wire body Newegg received carries exactly the previewed quantity.
      const put = harness.calls.find((call) => call.url.pathname.includes("inventoryandprice"));
      expect(put).toBeDefined();
      const body = put?.bodyJson as { Value: string; Inventory: string };
      expect(body.Value).toBe("A");
      expect(body.Inventory).toBe("42");
    } finally {
      await harness.close();
    }
  });

  it("rejects a second apply of the same preview (single-use)", async () => {
    const harness = await startHarness({ env: writesEnv(), routes: [inventoryAndPriceRoute()] });
    try {
      const preview = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: [{ identifier: { type: "sellerPartNumber", value: "A" }, quantity: 7 }],
      });
      const previewId = preview.json.previewId as string;
      const first = await callTool(harness.mcp, "newegg_inventory_apply_update", { previewId });
      expect(first.isError).toBe(false);
      const second = await callTool(harness.mcp, "newegg_inventory_apply_update", { previewId });
      expect(second.isError).toBe(true);
      expect(second.json.errorCode).toBe("preview_already_used");
    } finally {
      await harness.close();
    }
  });

  it("rejects an unknown previewId", async () => {
    const harness = await startHarness({ env: writesEnv() });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_apply_update", {
        previewId: "this-preview-does-not-exist",
      });
      expect(res.isError).toBe(true);
      expect(res.json.errorCode).toBe("preview_not_found");
    } finally {
      await harness.close();
    }
  });

  it("rejects an expired preview (injectable clock)", async () => {
    let nowMs = Date.parse("2026-07-10T00:00:00Z");
    const now = (): Date => new Date(nowMs);
    const harness = await startHarness({
      env: writesEnv({ NEWEGG_MCP_PREVIEW_TTL_SECONDS: "600" }),
      routes: [inventoryAndPriceRoute()],
      now,
    });
    try {
      const preview = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: [{ identifier: { type: "sellerPartNumber", value: "A" }, quantity: 3 }],
      });
      const previewId = preview.json.previewId as string;
      nowMs += 601_000;
      const apply = await callTool(harness.mcp, "newegg_inventory_apply_update", { previewId });
      expect(apply.isError).toBe(true);
      expect(apply.json.errorCode).toBe("preview_expired");
    } finally {
      await harness.close();
    }
  });

  it("is absent and unreachable when writes are disabled", async () => {
    const harness = await startHarness({ env: makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "false" }) });
    try {
      const tools = (
        (await harness.mcp.listTools()) as { tools: Array<{ name: string }> }
      ).tools.map((tool) => tool.name);
      expect(tools).not.toContain("newegg_inventory_apply_update");
      // Calling an unregistered tool surfaces as an isError result from the SDK.
      const res = await callTool(harness.mcp, "newegg_inventory_apply_update", { previewId: "x" });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe("preview policy enforcement", () => {
  it("bans zero-quantity updates when configured, listing offending indexes", async () => {
    const harness = await startHarness({
      env: writesEnv({ NEWEGG_MCP_ALLOW_ZERO_QUANTITY: "false" }),
    });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: [
          { identifier: { type: "sellerPartNumber", value: "A" }, quantity: 5 },
          { identifier: { type: "sellerPartNumber", value: "B" }, quantity: 0 },
        ],
      });
      expect(res.isError).toBe(true);
      expect(res.json.errorCode).toBe("zero_quantity_not_allowed");
      expect(res.json.message).toContain("1");
    } finally {
      await harness.close();
    }
  });

  it("enforces the warehouse allowlist", async () => {
    const harness = await startHarness({
      env: writesEnv({ NEWEGG_MCP_ALLOWED_WAREHOUSES: "USA,CAN" }),
    });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: [
          {
            identifier: { type: "sellerPartNumber", value: "A" },
            quantity: 5,
            warehouseLocation: "USA",
          },
          {
            identifier: { type: "sellerPartNumber", value: "B" },
            quantity: 5,
            warehouseLocation: "MEX",
          },
        ],
      });
      expect(res.isError).toBe(true);
      expect(res.json.errorCode).toBe("warehouse_not_allowed");
      expect(res.json.message).toContain("1");
    } finally {
      await harness.close();
    }
  });
});

describe("marketplace allowlist at config load", () => {
  it("throws when the configured marketplace is excluded", () => {
    expect(() =>
      loadMcpConfigFromEnv(
        makeEnv({ NEWEGG_MARKETPLACE: "ca", NEWEGG_MCP_ALLOWED_MARKETPLACES: "us,b2b" }),
      ),
    ).toThrow(/ALLOWED_MARKETPLACES/);
  });
});
