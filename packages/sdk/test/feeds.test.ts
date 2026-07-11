import { afterEach, describe, expect, it, vi } from "vitest";
import { IndeterminateFeedSubmissionError, InMemoryOperationStore } from "../src/index.js";
import type { InventoryUpdate } from "../src/index.js";
import { feedSubmitBody, makeClient, paths } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

interface Envelope {
  NeweggEnvelope: {
    Header: { DocumentVersion: string };
    MessageType: string;
    Overwrite?: string;
    Message: { Inventory: { Item: Array<Record<string, unknown>> } };
  };
}

/** A submit route that returns a distinct request id per call. */
function submitRoute(prefix = "REQ") {
  let n = 0;
  return {
    method: "POST",
    pathPattern: paths.feedSubmit,
    reply: () => ({ status: 200, body: feedSubmitBody(`${prefix}${n++}`) }),
  } as const;
}

function statusBody(requestId: string, status: string): unknown {
  return {
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
  };
}

const RESULT_BODY = {
  NeweggEnvelope: {
    Header: { DocumentVersion: "1.0" },
    MessageType: "ProcessingReport",
    Message: {
      ProcessingReport: {
        ProcessingSummary: { ProcessedCount: "3", SuccessCount: "1", WithErrorCount: "2" },
        Result: {
          AdditionalInfo: { SellerPartNumber: "sellerparttest001" },
          ErrorList: { ErrorDescription: "Error(s). Item not created." },
        },
      },
    },
  },
};

describe("feed submission envelopes", () => {
  it("builds the US INVENTORY_DATA envelope (DocumentVersion 2.0, Item as array)", async () => {
    const { client, calls } = makeClient("us", [submitRoute()]);
    await client.feeds.submitInventoryFeed({
      items: [
        {
          identifier: { type: "sellerPartNumber", value: "a006-test-001" },
          quantity: 200,
          warehouseLocation: "USA",
        },
      ],
    });
    expect(calls[0]!.url.searchParams.get("requesttype")).toBe("INVENTORY_DATA");
    expect(calls[0]!.bodyJson).toEqual({
      NeweggEnvelope: {
        Header: { DocumentVersion: "2.0" },
        MessageType: "Inventory",
        Message: {
          Inventory: {
            Item: [
              {
                SellerPartNumber: "a006-test-001",
                WarehouseLocation: "USA",
                FulfillmentOption: "Seller",
                Inventory: "200",
              },
            ],
          },
        },
      },
    });
  });

  it("builds the CA INVENTORY_AND_PRICE_DATA envelope (DocumentVersion 1.0, Overwrite No)", async () => {
    const { client, calls } = makeClient("ca", [submitRoute()]);
    await client.feeds.submitInventoryFeed({
      items: [{ identifier: { type: "sellerPartNumber", value: "SKU-1" }, quantity: 159 }],
    });
    expect(calls[0]!.url.searchParams.get("requesttype")).toBe("INVENTORY_AND_PRICE_DATA");
    expect(calls[0]!.bodyJson).toEqual({
      NeweggEnvelope: {
        Header: { DocumentVersion: "1.0" },
        MessageType: "Inventory",
        Overwrite: "No",
        Message: { Inventory: { Item: [{ SellerPartNumber: "SKU-1", Inventory: "159" }] } },
      },
    });
  });

  it("never emits Overwrite Yes regardless of input", async () => {
    const { client, calls } = makeClient("b2b", [submitRoute()]);
    await client.feeds.submitInventoryFeed({
      items: [{ identifier: { type: "sellerPartNumber", value: "SKU-1" }, quantity: 1 }],
    });
    expect((calls[0]!.bodyJson as Envelope).NeweggEnvelope.Overwrite).toBe("No");
  });
});

describe("feed chunking & assignments", () => {
  it("splits at the 10,000-record boundary with a stable order", async () => {
    const exactly = makeClient("us", [submitRoute("A")]);
    const items10k: InventoryUpdate[] = Array.from({ length: 10_000 }, (_, i) => ({
      identifier: { type: "sellerPartNumber", value: `SKU-${i}` },
      quantity: 1,
      warehouseLocation: "USA",
    }));
    const one = await exactly.client.feeds.submitInventoryFeed({ items: items10k });
    expect(one.feeds).toHaveLength(1);
    expect(exactly.calls).toHaveLength(1);

    const over = makeClient("us", [submitRoute("B")]);
    const items10k1 = [
      ...items10k,
      {
        identifier: { type: "sellerPartNumber" as const, value: "SKU-10000" },
        quantity: 1,
        warehouseLocation: "USA",
      },
    ];
    const two = await over.client.feeds.submitInventoryFeed({ items: items10k1 });
    expect(two.feeds).toHaveLength(2);
    expect(over.calls).toHaveLength(2);
    const chunk0 = over.calls[0]!.bodyJson as Envelope;
    const chunk1 = over.calls[1]!.bodyJson as Envelope;
    expect(chunk0.NeweggEnvelope.Message.Inventory.Item).toHaveLength(10_000);
    expect(chunk1.NeweggEnvelope.Message.Inventory.Item).toHaveLength(1);
    expect(chunk1.NeweggEnvelope.Message.Inventory.Item[0]!.SellerPartNumber).toBe("SKU-10000");
  });

  it("maps every accepted item to its feed via itemAssignments", async () => {
    const { client } = makeClient("us", [submitRoute()]);
    const submission = await client.feeds.submitInventoryFeed({
      items: [
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
      ],
    });
    expect(submission.itemAssignments).toHaveLength(3);
    expect(submission.itemAssignments.map((a) => a.inputIndex)).toEqual([0, 1, 2]);
    const requestId = submission.feeds[0]!.requestId;
    expect(submission.itemAssignments.every((a) => a.requestId === requestId)).toBe(true);
  });

  it("dedups duplicate SKU+warehouse last-write-wins and reports it", async () => {
    const { client, calls } = makeClient("us", [submitRoute()]);
    const submission = await client.feeds.submitInventoryFeed({
      items: [
        {
          identifier: { type: "sellerPartNumber", value: "X" },
          quantity: 1,
          warehouseLocation: "USA",
        },
        {
          identifier: { type: "sellerPartNumber", value: "X" },
          quantity: 9,
          warehouseLocation: "USA",
        },
        {
          identifier: { type: "sellerPartNumber", value: "Y" },
          quantity: 2,
          warehouseLocation: "USA",
        },
      ],
    });
    expect(submission.deduplicatedItemCount).toBe(1);
    const items = (calls[0]!.bodyJson as Envelope).NeweggEnvelope.Message.Inventory.Item;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ SellerPartNumber: "X", Inventory: "9" });
  });
});

describe("feed status, result, and polling", () => {
  it("returns UNKNOWN when the request id is not found in the status response", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.feedStatus,
        reply: () => ({ status: 200, body: statusBody("OTHER", "FINISHED") }),
      },
    ]);
    const report = await client.feeds.getStatus("REQ1");
    expect(report.status).toBe("UNKNOWN");
  });

  it("parses a FINISHED result with single-object Result and single-string ErrorDescription", async () => {
    const { client } = makeClient("us", [
      {
        method: "GET",
        pathPattern: paths.feedResult,
        reply: () => ({ status: 200, body: RESULT_BODY }),
      },
    ]);
    const result = await client.feeds.getResult("REQ1");
    expect(result.status).toBe("FINISHED");
    expect(result.summary).toEqual({ processed: 3, succeeded: 1, failed: 2 });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.status).toBe("failed");
    expect(result.records[0]!.sellerPartNumber).toBe("sellerparttest001");
  });

  it("throws NeweggApiError for a DF006 result body", async () => {
    const { client } = makeClient("us", [
      {
        method: "GET",
        pathPattern: paths.feedResult,
        reply: () => ({ status: 200, body: [{ Code: "DF006", Message: "invalid request id" }] }),
      },
    ]);
    await expect(client.feeds.getResult("BADID")).rejects.toMatchObject({
      name: "NeweggApiError",
      neweggErrorCode: "DF006",
    });
  });

  it("waitForResult resolves to finished and retrieves the result", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.feedStatus,
        reply: () => ({ status: 200, body: statusBody("REQ1", "FINISHED") }),
      },
      {
        method: "GET",
        pathPattern: paths.feedResult,
        reply: () => ({ status: 200, body: RESULT_BODY }),
      },
    ]);
    const outcome = await client.feeds.waitForResult("REQ1", {
      pollingIntervalMs: 1,
      timeoutMs: 1000,
    });
    expect(outcome.outcome).toBe("finished");
    if (outcome.outcome === "finished") {
      expect(outcome.result.summary.failed).toBe(2);
    }
  });

  it("waitForResult reports a cancelled feed", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.feedStatus,
        reply: () => ({ status: 200, body: statusBody("REQ1", "CANCELLED") }),
      },
    ]);
    const outcome = await client.feeds.waitForResult("REQ1", {
      pollingIntervalMs: 1,
      timeoutMs: 1000,
    });
    expect(outcome).toEqual({ outcome: "cancelled", requestId: "REQ1", status: "CANCELLED" });
  });

  it("waitForResult returns a timeout outcome without throwing (fake timers)", async () => {
    vi.useFakeTimers();
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.feedStatus,
        reply: () => ({ status: 200, body: statusBody("REQ1", "IN_PROGRESS") }),
      },
    ]);
    const promise = client.feeds.waitForResult("REQ1", {
      pollingIntervalMs: 1000,
      maxPollingIntervalMs: 1000,
      timeoutMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(7000);
    const outcome = await promise;
    expect(outcome).toEqual({
      outcome: "timeout",
      requestId: "REQ1",
      lastStatus: "IN_PROGRESS",
      elapsedMs: expect.any(Number),
    });
  });

  it("waitForResult propagates an aborted signal as AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.feedStatus,
        reply: () => ({ status: 200, body: statusBody("REQ1", "IN_PROGRESS") }),
      },
    ]);
    await expect(
      client.feeds.waitForResult("REQ1", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("feed submission retry & indeterminate handling", () => {
  it("throws IndeterminateFeedSubmissionError with a payloadHash on an ambiguous failure", async () => {
    const badFetch: typeof globalThis.fetch = () =>
      Promise.reject(new DOMException("aborted after dispatch", "AbortError"));
    const { client } = makeClient("us", [], { fetch: badFetch });
    let error: unknown;
    try {
      await client.feeds.submitInventoryFeed({
        items: [
          {
            identifier: { type: "sellerPartNumber", value: "x" },
            quantity: 1,
            warehouseLocation: "USA",
          },
        ],
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(IndeterminateFeedSubmissionError);
    expect((error as IndeterminateFeedSubmissionError).payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect((error as IndeterminateFeedSubmissionError).marketplace).toBe("us");
  });

  it("retries a pre-send (ECONNREFUSED) failure and then succeeds", async () => {
    let attempts = 0;
    const flakyFetch: typeof globalThis.fetch = () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));
      }
      return Promise.resolve(new Response(JSON.stringify(feedSubmitBody("REQ1")), { status: 200 }));
    };
    const { client } = makeClient("us", [], { fetch: flakyFetch });
    const submission = await client.feeds.submitInventoryFeed({
      items: [
        {
          identifier: { type: "sellerPartNumber", value: "x" },
          quantity: 1,
          warehouseLocation: "USA",
        },
      ],
    });
    expect(attempts).toBe(2);
    expect(submission.feeds).toHaveLength(1);
    expect(submission.feeds[0]!.requestId).toBe("REQ1");
  });

  it("does not double-submit an identical payload that is still 'submitting'", async () => {
    const operationStore = new InMemoryOperationStore();
    let attempts = 0;
    const badFetch: typeof globalThis.fetch = () => {
      attempts++;
      return Promise.reject(new DOMException("aborted after dispatch", "AbortError"));
    };
    const { client } = makeClient("us", [], { fetch: badFetch, operationStore });
    const items: InventoryUpdate[] = [
      {
        identifier: { type: "sellerPartNumber", value: "x" },
        quantity: 1,
        warehouseLocation: "USA",
      },
    ];

    await expect(client.feeds.submitInventoryFeed({ items })).rejects.toBeInstanceOf(
      IndeterminateFeedSubmissionError,
    );
    let second: unknown;
    try {
      await client.feeds.submitInventoryFeed({ items });
    } catch (err) {
      second = err;
    }
    expect(second).toBeInstanceOf(IndeterminateFeedSubmissionError);
    // The second submission is short-circuited by the dedup ledger — fetch is not called again.
    expect(attempts).toBe(1);
  });
});
