import { describe, expect, it } from "vitest";
import type { InventoryUpdate } from "../src/index.js";
import { feedSubmitBody, makeClient, paths } from "./helpers.js";

// Regression coverage for the updateMany -> feed path. Previously `#runFeed` passed
// NormalizedInventoryUpdate[] (carrying `inputIndex`) into `submitInventoryFeed`, whose
// strict schema rejected the extra key, so ANY updateMany routed to feeds failed pre-network.

function submitRoute(requestId = "REQ0") {
  return {
    method: "POST",
    pathPattern: paths.feedSubmit,
    reply: () => ({ status: 200, body: feedSubmitBody(requestId) }),
  } as const;
}

function statusRoute(requestId: string, status: string) {
  return {
    method: "PUT",
    pathPattern: paths.feedStatus,
    reply: () => ({
      status: 200,
      body: {
        ResponseBody: {
          ResponseList: [
            {
              RequestId: requestId,
              RequestStatus: status,
              RequestType: "INVENTORY_DATA",
              RequestDate: "2/22/2012 17:24:35",
            },
          ],
        },
      },
    }),
  } as const;
}

function resultRoute(failedSellerPartNumber: string) {
  return {
    method: "GET",
    pathPattern: paths.feedResult,
    reply: () => ({
      status: 200,
      body: {
        NeweggEnvelope: {
          Header: { DocumentVersion: "1.0" },
          MessageType: "ProcessingReport",
          Message: {
            ProcessingReport: {
              ProcessingSummary: { ProcessedCount: "3", SuccessCount: "2", WithErrorCount: "1" },
              Result: {
                AdditionalInfo: { SellerPartNumber: failedSellerPartNumber },
                ErrorList: { ErrorDescription: "Error. Item rejected." },
              },
            },
          },
        },
      },
    }),
  } as const;
}

const okDirect = {
  method: "POST",
  pathPattern: paths.usInventory,
  reply: () => ({ status: 200, body: {} }),
} as const;

interface FeedEnvelope {
  NeweggEnvelope: { Message: { Inventory: { Item: Array<Record<string, unknown>> } } };
}

function feedItems(call: { bodyJson?: unknown }): Array<Record<string, unknown>> {
  return (call.bodyJson as FeedEnvelope).NeweggEnvelope.Message.Inventory.Item;
}

describe("updateMany -> feed path", () => {
  it("submits via feed, waits, and maps per-item outcomes to original input indexes", async () => {
    const { client, calls } = makeClient("us", [
      submitRoute("REQ0"),
      statusRoute("REQ0", "FINISHED"),
      resultRoute("B"),
    ]);
    const items: InventoryUpdate[] = [
      {
        identifier: { type: "sellerPartNumber", value: "A" },
        quantity: 1,
        warehouseLocation: "USA",
      },
      {
        identifier: { type: "sellerPartNumber", value: "A" },
        quantity: 5,
        warehouseLocation: "USA",
      },
      {
        identifier: { type: "sellerPartNumber", value: "B" },
        quantity: 2,
        warehouseLocation: "USA",
      },
      {
        identifier: { type: "sellerPartNumber", value: "C" },
        quantity: 3,
        warehouseLocation: "USA",
      },
    ];
    const result = await client.inventory.updateMany(items, {
      strategy: "feed",
      waitForFeedCompletion: true,
    });

    expect(result.strategy).toBe("feed");
    expect(result.deduplicatedItemCount).toBe(1);
    expect(result.submittedItemCount).toBe(3);
    expect(result.feedJobs?.[0]?.status).toBe("FINISHED");

    const byIndex = (i: number) => result.items.find((item) => item.inputIndex === i);
    // Dedup kept the second "A" (inputIndex 1); the first (inputIndex 0) was dropped.
    expect(byIndex(0)).toBeUndefined();
    expect(byIndex(1)).toMatchObject({ sellerPartNumber: "A", status: "succeeded" });
    expect(byIndex(2)).toMatchObject({ sellerPartNumber: "B", status: "failed" });
    expect(byIndex(3)).toMatchObject({ sellerPartNumber: "C", status: "succeeded" });

    // Regression: the wire envelope must never contain `inputIndex`, and each line must
    // carry exactly the US feed keys.
    const submitCall = calls.find((call) => call.url.pathname.includes("submitfeed"));
    expect(submitCall).toBeDefined();
    expect(submitCall!.bodyText).not.toContain("inputIndex");
    const lines = feedItems(submitCall!);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual([
        "FulfillmentOption",
        "Inventory",
        "SellerPartNumber",
        "WarehouseLocation",
      ]);
    }
  });

  it("routes strategy 'auto' above the feed threshold to the feed path", async () => {
    const { client } = makeClient("us", [submitRoute("REQ0")], {
      strategy: { autoFeedThreshold: 2 },
    });
    const items: InventoryUpdate[] = [
      {
        identifier: { type: "sellerPartNumber", value: "A" },
        quantity: 1,
        warehouseLocation: "USA",
      },
      {
        identifier: { type: "sellerPartNumber", value: "B" },
        quantity: 2,
        warehouseLocation: "USA",
      },
      {
        identifier: { type: "sellerPartNumber", value: "C" },
        quantity: 3,
        warehouseLocation: "USA",
      },
    ];
    const result = await client.inventory.updateMany(items);
    expect(result.strategy).toBe("feed");
    expect(result.submittedItemCount).toBe(3);
    expect(result.failedItemCount).toBe(0);
    expect(result.items.every((item) => item.status === "submitted")).toBe(true);
    expect(result.feedJobs).toHaveLength(1);
  });

  it("round-trips previewUpdate().normalizedUpdates back into updateMany (direct)", async () => {
    const { client } = makeClient("us", [okDirect]);
    const preview = await client.inventory.previewUpdate([
      {
        identifier: { type: "sellerPartNumber", value: "A" },
        quantity: 1,
        warehouseLocation: "USA",
      },
      {
        identifier: { type: "sellerPartNumber", value: "B" },
        quantity: 2,
        warehouseLocation: "USA",
      },
    ]);
    expect(preview.strategy).toBe("direct");
    const result = await client.inventory.updateMany(preview.normalizedUpdates, {
      strategy: "direct",
    });
    expect(result.failedItemCount).toBe(0);
    expect(result.items.every((item) => item.status === "succeeded")).toBe(true);
  });

  it("round-trips previewUpdate().normalizedUpdates back into updateMany (feed)", async () => {
    const { client, calls } = makeClient("us", [submitRoute("REQ0")], {
      strategy: { autoFeedThreshold: 2 },
    });
    const preview = await client.inventory.previewUpdate([
      {
        identifier: { type: "sellerPartNumber", value: "A" },
        quantity: 1,
        warehouseLocation: "USA",
      },
      {
        identifier: { type: "sellerPartNumber", value: "B" },
        quantity: 2,
        warehouseLocation: "USA",
      },
      {
        identifier: { type: "sellerPartNumber", value: "C" },
        quantity: 3,
        warehouseLocation: "USA",
      },
    ]);
    expect(preview.strategy).toBe("feed");
    // normalizedUpdates carry `inputIndex`; feeding them back must not throw a validation error.
    const result = await client.inventory.updateMany(preview.normalizedUpdates, {
      strategy: "feed",
    });
    expect(result.strategy).toBe("feed");
    expect(result.submittedItemCount).toBe(3);
    const submitCall = calls.find((call) => call.url.pathname.includes("submitfeed"));
    expect(submitCall!.bodyText).not.toContain("inputIndex");
  });

  it("maps outcomes correctly on the mixed (direct + feed) auto path", async () => {
    const { client } = makeClient("us", [okDirect, submitRoute("REQ0")], {
      strategy: { autoFeedThreshold: 2 },
    });
    const items: InventoryUpdate[] = [
      {
        identifier: { type: "sellerPartNumber", value: "A" },
        quantity: 1,
        warehouseLocation: "USA",
      },
      {
        identifier: { type: "sellerPartNumber", value: "B" },
        quantity: 2,
        warehouseLocation: "USA",
      },
      {
        identifier: { type: "neweggItemNumber", value: "9SIA00000001" },
        quantity: 3,
        warehouseLocation: "USA",
      },
    ];
    const result = await client.inventory.updateMany(items);
    expect(result.strategy).toBe("mixed");
    const byIndex = (i: number) => result.items.find((item) => item.inputIndex === i);
    // SPN items -> feed (submitted, no wait); the non-SPN item -> direct (succeeded).
    expect(byIndex(0)).toMatchObject({ status: "submitted" });
    expect(byIndex(1)).toMatchObject({ status: "submitted" });
    expect(byIndex(2)).toMatchObject({ status: "succeeded" });
    expect(result.feedJobs).toHaveLength(1);
  });
});
