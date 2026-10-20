import { describe, expect, it } from "vitest";
import type { MockRoute } from "../src/testing/index.js";
import {
  IndeterminateFeedSubmissionError,
  NeweggApiError,
  NeweggFeedSubmissionError,
  NeweggValidationError,
  UnsupportedMarketplaceOperationError,
} from "../src/index.js";
import type { NormalizedVolumeDiscountUpdate, VolumeDiscountUpdate } from "../src/index.js";
import { buildVolumeDiscountEnvelope } from "../src/platform/volume-discount.js";
import { makeClient, paths } from "./helpers.js";

const ITEM = "9SIAFAKE0000001";

const readPath = /contentmgmt\/item\/volumediscount\?/;

/** Live-verified Get Volume Discount body (Newegg.ca, contracts §22.1): tiers as a bare array. */
const READ_BODY = {
  IsSuccess: true,
  OperationType: "GetVolumeDiscountResponse",
  SellerID: "A001",
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
};

function readRoute(status: number, body: unknown): MockRoute {
  return { method: "PUT", pathPattern: readPath, reply: () => ({ status, body }) };
}

function submitBody(requestId: string): unknown {
  return {
    IsSuccess: true,
    OperationType: "SubmitFeedResponse",
    ResponseBody: {
      ResponseList: [
        { RequestId: requestId, RequestStatus: "SUBMITTED", RequestType: "VOLUME_DISCOUNT_DATA" },
      ],
    },
  };
}

function submitRoute(): MockRoute {
  let n = 1;
  return {
    method: "POST",
    pathPattern: paths.feedSubmit,
    reply: () => ({ status: 200, body: submitBody(`VD-REQ-${n++}`) }),
  };
}

const TWO_TIERS: VolumeDiscountUpdate = {
  neweggItemNumber: ITEM,
  tiers: [
    { quantity: 5, sellingPrice: 97, freeShipping: true },
    { quantity: 10, sellingPrice: 95.006, freeShipping: true },
  ],
};

interface VdEnvelope {
  NeweggEnvelope: {
    Header: { DocumentVersion: string };
    MessageType: string;
    Message: {
      VolumeDiscountList: {
        ItemVolumeDiscountInfo: Array<{
          SellerPartNumber?: string;
          NeweggItemNumber?: string;
          VolumeActivation: string;
          DiscountSetting: { Tier: Array<Record<string, string>> };
        }>;
      };
    };
  };
}

describe("volume-discount envelope (contracts §22.3)", () => {
  it("builds the VolumeDiscount v1.0 envelope with string-typed tier fields", () => {
    const items: NormalizedVolumeDiscountUpdate[] = [
      {
        inputIndex: 0,
        sellerPartNumber: "FAKE-SKU-1",
        neweggItemNumber: ITEM,
        tiers: [
          { priority: 1, quantity: 5, sellingPrice: 97, freeShipping: true },
          { priority: 2, quantity: 10, sellingPrice: 95.5, freeShipping: false },
        ],
      },
    ];
    const envelope = buildVolumeDiscountEnvelope(items) as VdEnvelope;
    expect(envelope.NeweggEnvelope.Header.DocumentVersion).toBe("1.0");
    expect(envelope.NeweggEnvelope.MessageType).toBe("VolumeDiscount");
    const info = envelope.NeweggEnvelope.Message.VolumeDiscountList.ItemVolumeDiscountInfo;
    expect(Array.isArray(info)).toBe(true);
    expect(info[0]).toEqual({
      SellerPartNumber: "FAKE-SKU-1",
      NeweggItemNumber: ITEM,
      VolumeActivation: "True",
      DiscountSetting: {
        Tier: [
          { Priority: "1", Quantity: "5", SellingPrice: "97.00", EnableFreeShipping: "1" },
          { Priority: "2", Quantity: "10", SellingPrice: "95.50", EnableFreeShipping: "0" },
        ],
      },
    });
  });

  it("can never emit VolumeActivation False (which deletes a discount)", () => {
    const text = JSON.stringify(
      buildVolumeDiscountEnvelope([
        {
          inputIndex: 0,
          neweggItemNumber: ITEM,
          tiers: [{ priority: 1, quantity: 2, sellingPrice: 1, freeShipping: false }],
        },
      ]),
    );
    expect(text).toContain('"VolumeActivation":"True"');
    expect(text).not.toMatch(/false/i);
  });
});

describe("volumeDiscounts.previewUpdate", () => {
  it("normalizes tiers (priority from order, cents, default shipping) with zero network", () => {
    const { client, calls } = makeClient("ca", []);
    const preview = client.volumeDiscounts.previewUpdate({
      sellerPartNumber: "FAKE-SKU-1",
      tiers: [
        { quantity: 3, sellingPrice: 10.004 },
        { quantity: 6, sellingPrice: 9.5, freeShipping: true },
      ],
    });
    expect(calls).toHaveLength(0);
    expect(preview.marketplace).toBe("ca");
    expect(preview.itemCount).toBe(1);
    expect(preview.chunkCount).toBe(1);
    expect(preview.items[0]).toEqual({
      inputIndex: 0,
      sellerPartNumber: "FAKE-SKU-1",
      tiers: [
        { priority: 1, quantity: 3, sellingPrice: 10, freeShipping: false },
        { priority: 2, quantity: 6, sellingPrice: 9.5, freeShipping: true },
      ],
    });
    expect(preview.envelopes).toHaveLength(1);
    expect(preview.warnings.length).toBeGreaterThan(0);
  });

  it("warns when a higher tier turns free shipping on after a lower one lacks it", () => {
    const { client } = makeClient("ca", []);
    const preview = client.volumeDiscounts.previewUpdate({
      neweggItemNumber: ITEM,
      tiers: [
        { quantity: 3, sellingPrice: 10 },
        { quantity: 6, sellingPrice: 9, freeShipping: true },
      ],
    });
    expect(preview.warnings.join(" ")).toContain("CT063");
  });

  it("re-feeds its own normalized output (inputIndex and priority are tolerated)", () => {
    const { client } = makeClient("ca", []);
    const first = client.volumeDiscounts.previewUpdate(TWO_TIERS);
    const second = client.volumeDiscounts.previewUpdate(first.items);
    expect(second.items).toEqual(first.items);
    expect(second.envelopes).toEqual(first.envelopes);
  });

  const bad: Array<[string, unknown]> = [
    ["no identifier", { tiers: [{ quantity: 5, sellingPrice: 9 }] }],
    ["no tiers", { neweggItemNumber: ITEM, tiers: [] }],
    [
      "four tiers",
      {
        neweggItemNumber: ITEM,
        tiers: [
          { quantity: 2, sellingPrice: 9 },
          { quantity: 3, sellingPrice: 8 },
          { quantity: 4, sellingPrice: 7 },
          { quantity: 5, sellingPrice: 6 },
        ],
      },
    ],
    ["quantity 1", { neweggItemNumber: ITEM, tiers: [{ quantity: 1, sellingPrice: 9 }] }],
    [
      "fractional quantity",
      { neweggItemNumber: ITEM, tiers: [{ quantity: 2.5, sellingPrice: 9 }] },
    ],
    ["zero price", { neweggItemNumber: ITEM, tiers: [{ quantity: 5, sellingPrice: 0 }] }],
    ["negative price", { neweggItemNumber: ITEM, tiers: [{ quantity: 5, sellingPrice: -1 }] }],
    [
      "non-ascending quantities",
      {
        neweggItemNumber: ITEM,
        tiers: [
          { quantity: 10, sellingPrice: 9 },
          { quantity: 10, sellingPrice: 8 },
        ],
      },
    ],
    [
      "non-descending prices",
      {
        neweggItemNumber: ITEM,
        tiers: [
          { quantity: 5, sellingPrice: 9 },
          { quantity: 10, sellingPrice: 9.001 },
        ],
      },
    ],
    [
      "unknown key (e.g. a delete flag)",
      {
        neweggItemNumber: ITEM,
        volumeActivation: "False",
        tiers: [{ quantity: 5, sellingPrice: 9 }],
      },
    ],
  ];
  for (const [label, input] of bad) {
    it(`rejects ${label} before any network call`, () => {
      const { client, calls } = makeClient("ca", []);
      expect(() => client.volumeDiscounts.previewUpdate(input as VolumeDiscountUpdate)).toThrow(
        NeweggValidationError,
      );
      expect(calls).toHaveLength(0);
    });
  }

  it("rejects the same item twice in one call", () => {
    const { client } = makeClient("ca", []);
    expect(() => client.volumeDiscounts.previewUpdate([TWO_TIERS, TWO_TIERS])).toThrow(
      NeweggValidationError,
    );
  });

  it("is unsupported on US and B2B (writes were only verified on Newegg.ca)", () => {
    for (const marketplace of ["us", "b2b"] as const) {
      const { client } = makeClient(marketplace, []);
      expect(() => client.volumeDiscounts.previewUpdate(TWO_TIERS)).toThrow(
        UnsupportedMarketplaceOperationError,
      );
    }
  });
});

describe("volumeDiscounts.update (VOLUME_DISCOUNT_DATA feed, contracts §22.3)", () => {
  it("submits the feed and maps the item to the request id", async () => {
    const { client, calls } = makeClient("ca", [submitRoute()]);
    const submission = await client.volumeDiscounts.update(TWO_TIERS);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe("/marketplace/can/datafeedmgmt/feeds/submitfeed");
    expect(call.url.searchParams.get("requesttype")).toBe("VOLUME_DISCOUNT_DATA");
    expect(call.url.search).not.toContain("v2");
    const body = call.bodyJson as VdEnvelope;
    expect(body.NeweggEnvelope.MessageType).toBe("VolumeDiscount");
    const tiers =
      body.NeweggEnvelope.Message.VolumeDiscountList.ItemVolumeDiscountInfo[0]!.DiscountSetting
        .Tier;
    expect(tiers.map((t) => t.SellingPrice)).toEqual(["97.00", "95.01"]);
    expect(submission.feeds).toHaveLength(1);
    expect(submission.feeds[0]!.requestId).toBe("VD-REQ-1");
    expect(submission.feeds[0]!.requestType).toBe("VOLUME_DISCOUNT_DATA");
    expect(submission.itemAssignments).toEqual([
      { inputIndex: 0, requestId: "VD-REQ-1", chunkIndex: 0 },
    ]);
  });

  it("submits previewUpdate().items unchanged", async () => {
    const { client, calls } = makeClient("ca", [submitRoute()]);
    const preview = client.volumeDiscounts.previewUpdate(TWO_TIERS);
    await client.volumeDiscounts.update(preview.items);
    expect(calls[0]!.bodyJson).toEqual(preview.envelopes[0]);
  });

  it("never calls the direct (non-feed) volume-discount endpoint", async () => {
    const { client, calls } = makeClient("ca", [submitRoute()]);
    await client.volumeDiscounts.update(TWO_TIERS);
    expect(calls.every((c) => !readPath.test(c.url.pathname + "?"))).toBe(true);
  });

  it("validates before sending", async () => {
    const { client, calls } = makeClient("ca", [submitRoute()]);
    await expect(
      client.volumeDiscounts.update({ neweggItemNumber: ITEM, tiers: [] }),
    ).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });

  it("is unsupported (and sends nothing) on US and B2B", async () => {
    for (const marketplace of ["us", "b2b"] as const) {
      const { client, calls } = makeClient(marketplace, [submitRoute()]);
      await expect(client.volumeDiscounts.update(TWO_TIERS)).rejects.toBeInstanceOf(
        UnsupportedMarketplaceOperationError,
      );
      expect(calls).toHaveLength(0);
    }
  });

  it("dedups an identical resubmission via the operation ledger (ADR 0004)", async () => {
    const { client } = makeClient("ca", [submitRoute()]);
    await client.volumeDiscounts.update(TWO_TIERS);
    await expect(client.volumeDiscounts.update(TWO_TIERS)).rejects.toBeInstanceOf(
      IndeterminateFeedSubmissionError,
    );
  });

  it("throws NeweggFeedSubmissionError when Newegg reports IsSuccess:false", async () => {
    const { client } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.feedSubmit,
        reply: () => ({ status: 200, body: { IsSuccess: false } }),
      },
    ]);
    await expect(client.volumeDiscounts.update(TWO_TIERS)).rejects.toBeInstanceOf(
      NeweggFeedSubmissionError,
    );
  });
});

describe("volumeDiscounts.get (a READ via PUT, contracts §22.1)", () => {
  it("reads tiers by Newegg item number and normalizes them", async () => {
    const { client, calls } = makeClient("ca", [readRoute(200, READ_BODY)]);
    const snapshot = await client.volumeDiscounts.get({ neweggItemNumber: ITEM });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.pathname).toBe("/marketplace/can/contentmgmt/item/volumediscount");
    expect(calls[0]!.bodyJson).toEqual({
      OperationType: "GetVolumeDiscountRequest",
      RequestBody: { NeweggItemNumber: ITEM },
    });
    expect(snapshot.neweggItemNumber).toBe(ITEM);
    expect(snapshot.sellerPartNumber).toBe("FAKE-SKU-1");
    expect(snapshot.tiers).toEqual([
      { priority: 1, quantity: 5, sellingPrice: 95.5, freeShipping: true },
      { priority: 2, quantity: 10, sellingPrice: 90, freeShipping: false },
    ]);
  });

  it("reads by seller part number and accepts the documented { Tier: [...] } shape with strings", async () => {
    const body = {
      IsSuccess: "true",
      ResponseBody: {
        ItemVolumeDiscountInfo: {
          NeweggItemNumber: ITEM,
          DiscountSetting: {
            Tier: { Priority: "2", Quantity: "20", SellingPrice: "105", EnableFreeShipping: "0" },
          },
        },
      },
    };
    const { client, calls } = makeClient("ca", [readRoute(200, body)]);
    const snapshot = await client.volumeDiscounts.get({ sellerPartNumber: "FAKE-SKU-1" });
    expect(calls[0]!.bodyJson).toEqual({
      OperationType: "GetVolumeDiscountRequest",
      RequestBody: { SellerPartNumber: "FAKE-SKU-1" },
    });
    expect(snapshot.tiers).toEqual([
      { priority: 2, quantity: 20, sellingPrice: 105, freeShipping: false },
    ]);
  });

  it("reads on the US and B2B prefixes too", async () => {
    const us = makeClient("us", [readRoute(200, READ_BODY)]);
    await us.client.volumeDiscounts.get({ neweggItemNumber: ITEM });
    expect(us.calls[0]!.url.pathname).toBe("/marketplace/contentmgmt/item/volumediscount");
    const b2b = makeClient("b2b", [readRoute(200, READ_BODY)]);
    await b2b.client.volumeDiscounts.get({ neweggItemNumber: ITEM });
    expect(b2b.calls[0]!.url.pathname).toBe("/marketplace/b2b/contentmgmt/item/volumediscount");
  });

  it("requires an identifier", async () => {
    const { client, calls } = makeClient("ca", [readRoute(200, READ_BODY)]);
    await expect(client.volumeDiscounts.get({})).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });

  it("tryGet returns undefined for CT060 but still throws other codes", async () => {
    const notFound = makeClient("ca", [
      readRoute(400, [
        {
          Code: "CT060",
          Message: "Not found. The requested item does not have volume discount yet.",
        },
      ]),
    ]);
    await expect(
      notFound.client.volumeDiscounts.tryGet({ neweggItemNumber: ITEM }),
    ).resolves.toBeUndefined();
    await expect(
      notFound.client.volumeDiscounts.get({ neweggItemNumber: ITEM }),
    ).rejects.toBeInstanceOf(NeweggApiError);

    const invalid = makeClient("ca", [readRoute(400, [{ Code: "CT001", Message: "Invalid" }])]);
    await expect(
      invalid.client.volumeDiscounts.tryGet({ neweggItemNumber: ITEM }),
    ).rejects.toBeInstanceOf(NeweggApiError);
  });

  it("throws NeweggApiError when a 200 carries no volume discount payload", async () => {
    const { client } = makeClient("ca", [readRoute(200, { IsSuccess: true })]);
    await expect(client.volumeDiscounts.get({ neweggItemNumber: ITEM })).rejects.toBeInstanceOf(
      NeweggApiError,
    );
  });
});
