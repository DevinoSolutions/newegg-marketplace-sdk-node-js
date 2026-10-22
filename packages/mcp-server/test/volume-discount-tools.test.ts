import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { callTool, makeEnv, startHarness } from "./helpers.js";

const writesEnv = (overrides: Record<string, string | undefined> = {}) =>
  makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true", ...overrides });

const ITEM = "9SIAFAKE0000001";

/** §22.3 VOLUME_DISCOUNT_DATA feed submit success. */
function volumeDiscountSubmitRoute(requestId = "VD-REQ-9"): MockRoute {
  return {
    method: "POST",
    pathPattern: "datafeedmgmt/feeds/submitfeed",
    reply: () => ({
      status: 200,
      body: {
        IsSuccess: true,
        ResponseBody: {
          ResponseList: [
            {
              RequestId: requestId,
              RequestStatus: "SUBMITTED",
              RequestType: "VOLUME_DISCOUNT_DATA",
            },
          ],
        },
      },
    }),
  };
}

function readRoute(status: number, body: unknown): MockRoute {
  return {
    method: "PUT",
    pathPattern: /contentmgmt\/item\/volumediscount\?/,
    reply: () => ({ status, body }),
  };
}

const UPDATE = {
  neweggItemNumber: ITEM,
  sellerPartNumber: "FAKE-SKU-1",
  tiers: [
    { quantity: 5, sellingPrice: 95.5, freeShipping: true },
    { quantity: 10, sellingPrice: 90 },
  ],
};

describe("newegg_volume_discount_get", () => {
  it("returns the tiers of an item and is read-only", async () => {
    const harness = await startHarness({
      routes: [
        readRoute(200, {
          IsSuccess: true,
          ResponseBody: {
            ItemVolumeDiscountInfo: {
              SellerPartNumber: "FAKE-SKU-1",
              NeweggItemNumber: ITEM,
              DiscountSetting: [
                { Priority: 1, Quantity: 5, SellingPrice: 95.5, EnableFreeShipping: 1 },
                { Priority: 2, Quantity: 10, SellingPrice: 90, EnableFreeShipping: 0 },
              ],
            },
          },
        }),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_volume_discount_get", {
        neweggItemNumber: ITEM,
      });
      expect(res.isError).toBe(false);
      expect(res.json.hasVolumeDiscount).toBe(true);
      expect(res.json.tiers).toEqual([
        { priority: 1, quantity: 5, sellingPrice: 95.5, freeShipping: true },
        { priority: 2, quantity: 10, sellingPrice: 90, freeShipping: false },
      ]);
      expect(res.structuredContent).toEqual(res.json);
      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]?.method).toBe("PUT");
    } finally {
      await harness.close();
    }
  });

  it("passes a non-integer upstream tier priority through output validation", async () => {
    const harness = await startHarness({
      routes: [
        readRoute(200, {
          IsSuccess: true,
          ResponseBody: {
            ItemVolumeDiscountInfo: {
              SellerPartNumber: "FAKE-SKU-1",
              NeweggItemNumber: ITEM,
              DiscountSetting: [
                { Priority: "1.5", Quantity: 5, SellingPrice: 95.5, EnableFreeShipping: 1 },
              ],
            },
          },
        }),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_volume_discount_get", {
        neweggItemNumber: ITEM,
      });
      expect(res.isError).toBe(false);
      expect(res.json.tiers).toEqual([
        { priority: 1.5, quantity: 5, sellingPrice: 95.5, freeShipping: true },
      ]);
    } finally {
      await harness.close();
    }
  });

  it("reports hasVolumeDiscount=false for an item without a discount (CT060)", async () => {
    const harness = await startHarness({
      routes: [readRoute(400, [{ Code: "CT060", Message: "No volume discount yet." }])],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_volume_discount_get", {
        sellerPartNumber: "FAKE-SKU-1",
      });
      expect(res.isError).toBe(false);
      expect(res.json.hasVolumeDiscount).toBe(false);
      expect(res.json.tiers).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("rejects a call with no identifier before any network traffic", async () => {
    const harness = await startHarness({ routes: [readRoute(200, { IsSuccess: true })] });
    try {
      const res = await callTool(harness.mcp, "newegg_volume_discount_get", {});
      expect(res.isError).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_volume_discount_preview_update", () => {
  it("plans an update, echoes normalized tiers, and touches no network", async () => {
    const harness = await startHarness({
      env: writesEnv(),
      routes: [volumeDiscountSubmitRoute()],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_volume_discount_preview_update", {
        items: [UPDATE],
      });
      expect(res.isError).toBe(false);
      expect(res.json.mode).toBe("preview");
      expect(typeof res.json.previewId).toBe("string");
      expect((res.json.previewId as string).length).toBeGreaterThan(20);
      const expiry = res.json.previewExpiresAt as string;
      expect(new Date(expiry).toISOString()).toBe(expiry);
      expect(res.structuredContent).toEqual(res.json);

      const items = res.json.items as Array<{ tiers: Array<Record<string, unknown>> }>;
      expect(items).toHaveLength(1);
      expect(items[0]?.tiers).toEqual([
        { priority: 1, quantity: 5, sellingPrice: 95.5, freeShipping: true },
        { priority: 2, quantity: 10, sellingPrice: 90, freeShipping: false },
      ]);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("is not registered when writes are disabled (T-6103: the preview is the write flow)", async () => {
    const harness = await startHarness({ env: makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "false" }) });
    try {
      const tools = (
        (await harness.mcp.listTools()) as { tools: Array<{ name: string }> }
      ).tools.map((tool) => tool.name);
      expect(tools).not.toContain("newegg_volume_discount_preview_update");
      expect(tools).not.toContain("newegg_volume_discount_apply_update");
      expect(tools).toContain("newegg_volume_discount_get");
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["more than three tiers", [5, 6, 7, 8].map((q, i) => ({ quantity: q, sellingPrice: 90 - i }))],
    [
      "non-ascending quantities",
      [
        { quantity: 10, sellingPrice: 95 },
        { quantity: 5, sellingPrice: 90 },
      ],
    ],
    [
      "non-descending prices",
      [
        { quantity: 5, sellingPrice: 90 },
        { quantity: 10, sellingPrice: 95 },
      ],
    ],
    ["a quantity below 2", [{ quantity: 1, sellingPrice: 90 }]],
  ])("rejects %s", async (_label, tiers) => {
    const harness = await startHarness({ env: writesEnv() });
    try {
      const res = await callTool(harness.mcp, "newegg_volume_discount_preview_update", {
        items: [{ neweggItemNumber: ITEM, tiers }],
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("rejects an item with no identifier", async () => {
    const harness = await startHarness({ env: writesEnv() });
    try {
      const res = await callTool(harness.mcp, "newegg_volume_discount_preview_update", {
        items: [{ tiers: [{ quantity: 5, sellingPrice: 90 }] }],
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("surfaces the SDK's unsupported-marketplace error on US", async () => {
    const harness = await startHarness({ env: writesEnv({ NEWEGG_MARKETPLACE: "us" }) });
    try {
      const res = await callTool(harness.mcp, "newegg_volume_discount_preview_update", {
        items: [UPDATE],
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_volume_discount_apply_update", () => {
  it("is absent and unreachable when writes are disabled", async () => {
    const harness = await startHarness({ env: makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "false" }) });
    try {
      const res = await callTool(harness.mcp, "newegg_volume_discount_apply_update", {
        previewId: "x",
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("consumes the previewId and submits the VOLUME_DISCOUNT_DATA feed", async () => {
    const harness = await startHarness({
      env: writesEnv(),
      routes: [volumeDiscountSubmitRoute("VD-REQ-9")],
    });
    try {
      const preview = await callTool(harness.mcp, "newegg_volume_discount_preview_update", {
        items: [UPDATE],
      });
      const previewId = preview.json.previewId as string;

      const apply = await callTool(harness.mcp, "newegg_volume_discount_apply_update", {
        previewId,
      });
      expect(apply.isError).toBe(false);
      expect(apply.json.mode).toBe("apply");
      const feedJobs = apply.json.feedJobs as Array<{ requestId: string; requestType: string }>;
      expect(feedJobs).toHaveLength(1);
      expect(feedJobs[0]?.requestId).toBe("VD-REQ-9");
      expect(feedJobs[0]?.requestType).toBe("VOLUME_DISCOUNT_DATA");
      const warnings = apply.json.warnings as string[];
      expect(warnings.some((w) => w.includes("newegg_feed_status"))).toBe(true);

      const submit = harness.calls.find((call) =>
        call.url.pathname.includes("datafeedmgmt/feeds/submitfeed"),
      );
      expect(submit).toBeDefined();
      expect(submit?.method).toBe("POST");
      expect(submit?.url.search).toContain("requesttype=VOLUME_DISCOUNT_DATA");
    } finally {
      await harness.close();
    }
  });

  it("only applies the stored tiers: extra arguments are rejected", async () => {
    const harness = await startHarness({
      env: writesEnv(),
      routes: [volumeDiscountSubmitRoute()],
    });
    try {
      const preview = await callTool(harness.mcp, "newegg_volume_discount_preview_update", {
        items: [UPDATE],
      });
      const res = await callTool(harness.mcp, "newegg_volume_discount_apply_update", {
        previewId: preview.json.previewId as string,
        items: [UPDATE],
      });
      expect(res.isError).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("rejects a second apply of the same preview (single-use)", async () => {
    const harness = await startHarness({
      env: writesEnv(),
      routes: [volumeDiscountSubmitRoute()],
    });
    try {
      const preview = await callTool(harness.mcp, "newegg_volume_discount_preview_update", {
        items: [UPDATE],
      });
      const previewId = preview.json.previewId as string;
      const first = await callTool(harness.mcp, "newegg_volume_discount_apply_update", {
        previewId,
      });
      expect(first.isError).toBe(false);
      const second = await callTool(harness.mcp, "newegg_volume_discount_apply_update", {
        previewId,
      });
      expect(second.isError).toBe(true);
      expect(second.json.errorCode).toBe("preview_already_used");
    } finally {
      await harness.close();
    }
  });

  it("rejects a listing previewId applied through the volume-discount tool (kind mismatch)", async () => {
    const harness = await startHarness({ env: writesEnv() });
    try {
      const preview = await callTool(harness.mcp, "newegg_listing_preview_create", {
        items: [
          {
            sellerPartNumber: "FAKE-SKU-1",
            manufacturer: "FakeBrand",
            upc: "000000000000",
            sellingPrice: 10,
            quantity: 1,
          },
        ],
      });
      const apply = await callTool(harness.mcp, "newegg_volume_discount_apply_update", {
        previewId: preview.json.previewId as string,
      });
      expect(apply.isError).toBe(true);
      expect(apply.json.errorCode).toBe("preview_kind_mismatch");
    } finally {
      await harness.close();
    }
  });
});
