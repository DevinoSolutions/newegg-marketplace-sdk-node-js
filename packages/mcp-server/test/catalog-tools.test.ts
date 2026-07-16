import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { CatalogLookupTimeoutError } from "@devino/newegg-marketplace-sdk";
import type { NeweggClient } from "@devino/newegg-marketplace-sdk";
import { loadMcpConfigFromEnv, InMemoryPreviewStore } from "../src/index.js";
import { catalogResolveTool } from "../src/tools/catalog.js";
import type { ToolContext } from "../src/tools/shared.js";
import { callTool, makeEnv, startHarness } from "./helpers.js";

// ---------------------------------------------------------------------------
// wire routes (shapes proven by the SDK's own catalog tests / contracts §12)
// ---------------------------------------------------------------------------
const SUBMIT_OK = {
  IsSuccess: true,
  OperationType: "ItemLookupReportResponse",
  ResponseBody: {
    ResponseList: [{ RequestId: "REQ123", RequestType: "ITEM_LOOKUP", RequestStatus: "SUBMITTED" }],
  },
};
const STATUS_FINISHED = {
  ResponseBody: { ResponseList: [{ RequestId: "REQ123", RequestStatus: "FINISHED" }] },
};
const RESULT_PAGE = {
  ResponseBody: {
    PageInfo: { TotalCount: "1", TotalPageCount: "1", PageIndex: "1", PageSize: "100" },
    ItemList: [
      {
        NeweggItemNumber: "9SIA0060884598",
        UPC: "812674021181",
        Condition: "1",
        WebsiteShortTitle: "Corsair MP700 Micro 2TB NVMe SSD",
      },
    ],
  },
};

function catalogRoutes(inventoryHasItem: boolean): MockRoute[] {
  return [
    {
      method: "POST",
      pathPattern: /reportmgmt\/report\/submitrequest/,
      reply: () => ({ status: 200, body: SUBMIT_OK }),
    },
    {
      method: "PUT",
      pathPattern: /reportmgmt\/report\/status/,
      reply: () => ({ status: 200, body: STATUS_FINISHED }),
    },
    {
      method: "PUT",
      pathPattern: /reportmgmt\/report\/result/,
      reply: () => ({ status: 200, body: RESULT_PAGE }),
    },
    {
      // alreadyListed check: CA single-item inventory read (tryGetItem; CA reads are POST).
      method: "POST",
      pathPattern: /contentmgmt\/item\/inventory\?/,
      reply: () =>
        inventoryHasItem
          ? {
              status: 200,
              body: {
                Active: "1",
                ItemNumber: "9SIA0060884598",
                SellerPartNumber: "SPN-1",
                FulfillmentOption: "0",
                AvailableQuantity: 3,
              },
            }
          : {
              status: 400,
              body: [{ Code: "CT026", Message: "Item does not exist" }],
            },
    },
  ];
}

describe("newegg_catalog_resolve (end-to-end)", () => {
  it("resolves a UPC to a NeweggItemNumber with alreadyListed=true", async () => {
    const harness = await startHarness({ routes: catalogRoutes(true) });
    try {
      const res = await callTool(harness.mcp, "newegg_catalog_resolve", {
        items: [{ upc: "812674021181" }],
      });
      expect(res.isError).toBe(false);
      expect(res.json.pending).toBe(false);
      expect(res.json.requestId).toBe("REQ123");
      const resolutions = res.json.resolutions as Array<{
        found: boolean;
        matches: Array<Record<string, unknown>>;
      }>;
      expect(resolutions).toHaveLength(1);
      expect(resolutions[0]?.found).toBe(true);
      const match = resolutions[0]?.matches[0];
      expect(match?.neweggItemNumber).toBe("9SIA0060884598");
      expect(match?.websiteShortTitle).toBe("Corsair MP700 Micro 2TB NVMe SSD");
      expect(match?.alreadyListed).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("reports alreadyListed=false when the seller has no offer on the item", async () => {
    const harness = await startHarness({ routes: catalogRoutes(false) });
    try {
      const res = await callTool(harness.mcp, "newegg_catalog_resolve", {
        items: [{ upc: "812674021181" }],
      });
      expect(res.isError).toBe(false);
      const resolutions = res.json.resolutions as Array<{
        matches: Array<Record<string, unknown>>;
      }>;
      expect(resolutions[0]?.matches[0]?.alreadyListed).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("passes a neweggItemNumber through without hitting reportmgmt", async () => {
    const harness = await startHarness({ routes: catalogRoutes(true) });
    try {
      const res = await callTool(harness.mcp, "newegg_catalog_resolve", {
        items: [{ neweggItemNumber: "9SIA0060884598" }],
      });
      expect(res.isError).toBe(false);
      expect(res.json.requestId).toBeUndefined();
      const reportCalls = harness.calls.filter((c) => c.url.pathname.includes("reportmgmt"));
      expect(reportCalls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("rejects an item mixing identifier families", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      const res = await callTool(harness.mcp, "newegg_catalog_resolve", {
        items: [{ upc: "812674021181", neweggItemNumber: "9SIA1" }],
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("rejects manufacturer without manufacturerPartNumber", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      const res = await callTool(harness.mcp, "newegg_catalog_resolve", {
        items: [{ manufacturer: "Corsair" }],
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_catalog_resolve (pending path)", () => {
  it("returns pending=true with the requestId when the report times out", async () => {
    // Handler-level test with a stub client: the SDK facade throwing the timeout error is
    // already covered by the SDK suite; here we assert the tool's pending translation.
    const stubClient = {
      marketplace: "ca",
      catalog: {
        resolve: () => {
          throw new CatalogLookupTimeoutError("not finished", { requestId: "REQ9" });
        },
      },
    } as unknown as NeweggClient;
    const ctx: ToolContext = {
      client: stubClient,
      config: loadMcpConfigFromEnv(makeEnv()),
      previewStore: new InMemoryPreviewStore(),
      logger: () => {},
      now: () => new Date(),
    };
    const result = await catalogResolveTool.handler({ items: [{ upc: "812674021181" }] }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.structuredContent.pending).toBe(true);
      expect(result.structuredContent.requestId).toBe("REQ9");
      expect(String(result.structuredContent.message)).toContain("newegg_catalog_lookup_status");
    }
  });

  it("surfaces a CANCELLED report (non-retryable) as a structured error, not pending", async () => {
    const stubClient = {
      marketplace: "ca",
      catalog: {
        resolve: () => {
          throw new CatalogLookupTimeoutError("cancelled", {
            requestId: "REQ9",
            retryable: false,
          });
        },
      },
    } as unknown as NeweggClient;
    const ctx: ToolContext = {
      client: stubClient,
      config: loadMcpConfigFromEnv(makeEnv()),
      previewStore: new InMemoryPreviewStore(),
      logger: () => {},
      now: () => new Date(),
    };
    const result = await catalogResolveTool.handler({ items: [{ upc: "812674021181" }] }, ctx);
    expect(result.ok).toBe(false);
  });
});

describe("newegg_catalog_lookup_status (end-to-end)", () => {
  it("returns the in-flight status without matches", async () => {
    const harness = await startHarness({
      routes: [
        {
          method: "PUT",
          pathPattern: /reportmgmt\/report\/status/,
          reply: () => ({
            status: 200,
            body: {
              ResponseBody: {
                ResponseList: [{ RequestId: "REQ123", RequestStatus: "IN_PROGRESS" }],
              },
            },
          }),
        },
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_catalog_lookup_status", {
        requestId: "REQ123",
      });
      expect(res.isError).toBe(false);
      expect(res.json.status).toBe("inProgress");
      expect(res.json.matches).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("returns matches when the report is finished", async () => {
    const harness = await startHarness({ routes: catalogRoutes(true) });
    try {
      const res = await callTool(harness.mcp, "newegg_catalog_lookup_status", {
        requestId: "REQ123",
      });
      expect(res.isError).toBe(false);
      expect(res.json.status).toBe("finished");
      const matches = res.json.matches as Array<Record<string, unknown>>;
      expect(matches).toHaveLength(1);
      expect(matches[0]?.neweggItemNumber).toBe("9SIA0060884598");
      expect(matches[0]?.alreadyListed).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
