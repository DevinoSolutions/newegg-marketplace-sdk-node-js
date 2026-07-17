import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { callTool, makeEnv, startHarness } from "./helpers.js";

const writesEnv = (overrides: Record<string, string | undefined> = {}) =>
  makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true", ...overrides });

/** §13 existing-item creation submit success (ITEM_DATA&v2). */
function listingSubmitRoute(requestId = "REQ-9"): MockRoute {
  return {
    method: "POST",
    pathPattern: "datafeedmgmt/feeds/submitfeed",
    reply: () => ({
      status: 200,
      body: {
        IsSuccess: true,
        ResponseBody: {
          ResponseList: [
            { RequestId: requestId, RequestStatus: "SUBMITTED", RequestType: "ITEM_DATA" },
          ],
        },
      },
    }),
  };
}

const ITEM = {
  sellerPartNumber: "EB-TEST-1",
  manufacturer: "Corsair",
  upc: "840006676577",
  sellingPrice: 129.99,
  quantity: 1,
};

describe("newegg_listing_preview_create", () => {
  it("plans a creation, echoes normalized defaults, and touches no network", async () => {
    const harness = await startHarness({ env: writesEnv(), routes: [listingSubmitRoute()] });
    try {
      const res = await callTool(harness.mcp, "newegg_listing_preview_create", {
        items: [ITEM],
      });
      expect(res.isError).toBe(false);
      expect(res.json.mode).toBe("preview");
      expect(typeof res.json.previewId).toBe("string");
      expect((res.json.previewId as string).length).toBeGreaterThan(20);
      const expiry = res.json.previewExpiresAt as string;
      expect(new Date(expiry).toISOString()).toBe(expiry);
      expect(res.structuredContent).toEqual(res.json);

      const items = res.json.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0]?.sellerPartNumber).toBe("EB-TEST-1");
      expect(items[0]?.condition).toBe("New");
      expect(items[0]?.activate).toBe(false);

      const warnings = res.json.warnings as string[];
      expect(warnings.some((w) => w.includes("DEACTIVATED"))).toBe(true);

      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("rejects an item with no catalog identifier", async () => {
    const harness = await startHarness({ env: writesEnv() });
    try {
      const res = await callTool(harness.mcp, "newegg_listing_preview_create", {
        items: [
          { sellerPartNumber: "EB-TEST-1", manufacturer: "Corsair", sellingPrice: 10, quantity: 1 },
        ],
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_listing_apply_create", () => {
  it("is absent and unreachable when writes are disabled", async () => {
    const harness = await startHarness({ env: makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "false" }) });
    try {
      const tools = (
        (await harness.mcp.listTools()) as { tools: Array<{ name: string }> }
      ).tools.map((tool) => tool.name);
      expect(tools).not.toContain("newegg_listing_apply_create");
      const res = await callTool(harness.mcp, "newegg_listing_apply_create", { previewId: "x" });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("consumes the previewId and submits the ITEM_DATA&v2 feed", async () => {
    const harness = await startHarness({ env: writesEnv(), routes: [listingSubmitRoute("REQ-9")] });
    try {
      const preview = await callTool(harness.mcp, "newegg_listing_preview_create", {
        items: [ITEM],
      });
      const previewId = preview.json.previewId as string;

      const apply = await callTool(harness.mcp, "newegg_listing_apply_create", { previewId });
      expect(apply.isError).toBe(false);
      expect(apply.json.mode).toBe("apply");
      const feedJobs = apply.json.feedJobs as Array<{ requestId: string }>;
      expect(feedJobs.some((job) => job.requestId === "REQ-9")).toBe(true);
      const warnings = apply.json.warnings as string[];
      expect(warnings.some((w) => w.includes("newegg_feed_status"))).toBe(true);

      const submit = harness.calls.find((call) =>
        call.url.pathname.includes("datafeedmgmt/feeds/submitfeed"),
      );
      expect(submit).toBeDefined();
      expect(submit?.url.search).toContain("&v2");
    } finally {
      await harness.close();
    }
  });

  it("rejects a second apply of the same preview (single-use)", async () => {
    const harness = await startHarness({ env: writesEnv(), routes: [listingSubmitRoute()] });
    try {
      const preview = await callTool(harness.mcp, "newegg_listing_preview_create", {
        items: [ITEM],
      });
      const previewId = preview.json.previewId as string;
      const first = await callTool(harness.mcp, "newegg_listing_apply_create", { previewId });
      expect(first.isError).toBe(false);
      const second = await callTool(harness.mcp, "newegg_listing_apply_create", { previewId });
      expect(second.isError).toBe(true);
      expect(second.json.errorCode).toBe("preview_already_used");
    } finally {
      await harness.close();
    }
  });

  it("rejects an inventory previewId applied through the listing tool (kind mismatch)", async () => {
    const harness = await startHarness({ env: writesEnv() });
    try {
      const preview = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: [{ identifier: { type: "sellerPartNumber", value: "A" }, quantity: 5 }],
      });
      const previewId = preview.json.previewId as string;
      const apply = await callTool(harness.mcp, "newegg_listing_apply_create", { previewId });
      expect(apply.isError).toBe(true);
      expect(apply.json.errorCode).toBe("preview_kind_mismatch");
    } finally {
      await harness.close();
    }
  });

  it("rejects a listing previewId applied through the inventory tool (reverse kind mismatch)", async () => {
    const harness = await startHarness({ env: writesEnv() });
    try {
      const preview = await callTool(harness.mcp, "newegg_listing_preview_create", {
        items: [ITEM],
      });
      const previewId = preview.json.previewId as string;
      const apply = await callTool(harness.mcp, "newegg_inventory_apply_update", { previewId });
      expect(apply.isError).toBe(true);
      expect(apply.json.errorCode).toBe("preview_kind_mismatch");
    } finally {
      await harness.close();
    }
  });
});
