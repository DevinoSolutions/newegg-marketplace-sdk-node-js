import { describe, expect, it } from "vitest";
import {
  IndeterminateFeedSubmissionError,
  NeweggFeedSubmissionError,
  NeweggValidationError,
} from "../src/index.js";
import type { CreateListingInput } from "../src/index.js";
import { buildExistingItemEnvelope } from "../src/listings/envelope.js";
import type { NormalizedCreateListing } from "../src/index.js";
import { makeClient, paths } from "./helpers.js";

/** §13.4 Existing Item Creation submit-success body (RequestType ITEM_DATA). */
function itemFeedSubmitBody(requestId: string, status = "SUBMITTED"): unknown {
  return {
    IsSuccess: true,
    OperationType: "SubmitFeedResponse",
    ResponseBody: {
      ResponseList: [{ RequestId: requestId, RequestStatus: status, RequestType: "ITEM_DATA" }],
    },
  };
}

/** A submit route that returns a distinct request id per call. */
function submitRoute(prefix = "REQ-") {
  let n = 1;
  return {
    method: "POST",
    pathPattern: paths.feedSubmit,
    reply: () => ({ status: 200, body: itemFeedSubmitBody(`${prefix}${n++}`) }),
  } as const;
}

const MINIMAL: CreateListingInput = {
  sellerPartNumber: "EB-TEST-1",
  manufacturer: "Corsair",
  upc: "840006676577",
  sellingPrice: 129.99,
  quantity: 1,
};

/** Builds N minimal, uniquely-identified inputs (for chunking). */
function manyInputs(count: number): CreateListingInput[] {
  return Array.from({ length: count }, (_, i) => ({
    sellerPartNumber: `EB-SKU-${i}`,
    manufacturer: "Corsair",
    manufacturerPartNumber: `MPN-${i}`,
    sellingPrice: 9.99,
    quantity: 1,
  }));
}

interface ItemEnvelope {
  NeweggEnvelope: {
    Header: { DocumentVersion: string };
    MessageType: string;
    Message: { Itemfeed: Array<{ Item: Array<{ BasicInfo: Record<string, unknown> }> }> };
  };
}

describe("listings envelope (contracts §13.2)", () => {
  it("builds the BatchItemCreation v2 envelope shape", () => {
    const items: NormalizedCreateListing[] = [
      {
        inputIndex: 0,
        sellerPartNumber: "EB-1",
        manufacturer: "Corsair",
        manufacturerPartNumber: "CM-100",
        upc: "840006676577",
        neweggItemNumber: "9SIA000001",
        sellingPrice: 1299.99,
        quantity: 5,
        condition: "New",
        packsOrSets: 1,
        shipping: "Default",
        activate: false,
        checkoutMap: true,
        leadTime: 3,
      },
    ];
    const envelope = buildExistingItemEnvelope(items) as ItemEnvelope;
    expect(envelope.NeweggEnvelope.Header.DocumentVersion).toBe("2.0");
    expect(envelope.NeweggEnvelope.MessageType).toBe("BatchItemCreation");
    expect(envelope.NeweggEnvelope.Message.Itemfeed).toHaveLength(1);
    expect(Array.isArray(envelope.NeweggEnvelope.Message.Itemfeed[0]!.Item)).toBe(true);
    const basic = envelope.NeweggEnvelope.Message.Itemfeed[0]!.Item[0]!.BasicInfo;
    expect(basic.ManufacturerPartsNumber).toBe("CM-100");
    expect(basic.UPCOrISBN).toBe("840006676577");
    expect(basic.CheckoutMAP).toBe("True");
    expect(basic.ActivationMark).toBe("False");
    expect(basic.SellingPrice).toBe("1299.99");
    expect(basic.Inventory).toBe("5");
    expect(basic.PacksOrSets).toBe("1");
    expect(basic.LeadTime).toBe("3");
    // v2 has no Overwrite; SummaryInfo is XML-only and omitted in JSON.
    expect(JSON.stringify(envelope)).not.toContain("Overwrite");
    expect(JSON.stringify(envelope)).not.toContain("SummaryInfo");
  });

  it("formats money as a rounded 2-decimal string (locks the contract)", () => {
    function priceOf(sellingPrice: number, msrp: number): { selling: unknown; msrp: unknown } {
      const item: NormalizedCreateListing = {
        inputIndex: 0,
        sellerPartNumber: "EB-1",
        manufacturer: "Corsair",
        upc: "840006676577",
        sellingPrice,
        msrp,
        quantity: 1,
        condition: "New",
        packsOrSets: 1,
        shipping: "Default",
        activate: false,
      };
      const basic = (buildExistingItemEnvelope([item]) as ItemEnvelope).NeweggEnvelope.Message
        .Itemfeed[0]!.Item[0]!.BasicInfo;
      return { selling: basic.SellingPrice, msrp: basic.MSRP };
    }
    // Trailing zero padded; float artifact (2.675) rounds up to the nearest cent, not truncated.
    expect(priceOf(9.9, 2.675)).toEqual({ selling: "9.90", msrp: "2.68" });
    expect(priceOf(1000, 0.1).selling).toBe("1000.00");
  });
});

describe("listings.previewCreate", () => {
  it("normalizes defaults (New / 1 / Default / deactivated)", () => {
    const { client, calls } = makeClient("ca", []);
    const preview = client.listings.previewCreate(MINIMAL);
    expect(calls).toHaveLength(0); // offline
    const item = preview.items[0]!;
    expect(item.condition).toBe("New");
    expect(item.packsOrSets).toBe(1);
    expect(item.shipping).toBe("Default");
    expect(item.activate).toBe(false);
    const basic = (preview.envelopes[0] as ItemEnvelope).NeweggEnvelope.Message.Itemfeed[0]!
      .Item[0]!.BasicInfo;
    expect(basic.ActivationMark).toBe("False");
    expect(preview.warnings.some((w) => w.includes("DEACTIVATED"))).toBe(true);
  });

  it("makes zero fetch calls", () => {
    const { client, calls } = makeClient("ca", []);
    client.listings.previewCreate([MINIMAL, { ...MINIMAL, sellerPartNumber: "EB-TEST-2" }]);
    expect(calls).toHaveLength(0);
  });
});

describe("listings validation", () => {
  const cases: Array<[string, CreateListingInput | CreateListingInput[]]> = [
    [
      "no identifier",
      { sellerPartNumber: "A", manufacturer: "Corsair", sellingPrice: 1, quantity: 1 },
    ],
    ["sellerPartNumber > 40 chars", { ...MINIMAL, sellerPartNumber: "X".repeat(41) }],
    ["sellingPrice 0", { ...MINIMAL, sellingPrice: 0 }],
    ["leadTime 15", { ...MINIMAL, leadTime: 15 }],
    ["unknown key", { ...MINIMAL, bogusField: "nope" } as unknown as CreateListingInput],
    ["duplicate sellerPartNumber", [MINIMAL, { ...MINIMAL, upc: "111111111111" }]],
  ];
  for (const [name, input] of cases) {
    it(`rejects: ${name}`, () => {
      const { client } = makeClient("ca", []);
      expect(() => client.listings.previewCreate(input)).toThrow(NeweggValidationError);
    });
  }
});

describe("listings.create wire (contracts §13.1)", () => {
  it("submits ITEM_DATA&v2 and maps items to the request id", async () => {
    const { client, calls } = makeClient("ca", [submitRoute()]);
    const submission = await client.listings.create(MINIMAL);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url.searchParams.get("requesttype")).toBe("ITEM_DATA");
    expect(call.url.search).toContain("&v2");
    expect(call.url.search).not.toContain("v2=");
    expect(call.url.pathname).toContain("datafeedmgmt/feeds/submitfeed");
    const body = call.bodyJson as ItemEnvelope;
    expect(body.NeweggEnvelope.MessageType).toBe("BatchItemCreation");
    expect(body.NeweggEnvelope.Message.Itemfeed[0]!.Item[0]!.BasicInfo.SellerPartNumber).toBe(
      "EB-TEST-1",
    );
    expect(submission.feeds).toHaveLength(1);
    expect(submission.feeds[0]!.requestId).toBe("REQ-1");
    expect(submission.feeds[0]!.requestType).toBe("ITEM_DATA");
    expect(submission.itemAssignments).toEqual([
      { inputIndex: 0, requestId: "REQ-1", chunkIndex: 0 },
    ]);
    expect(submission.deduplicatedItemCount).toBe(0);
  });

  it("chunks 3001 items into two submitfeed calls (3000 + 1)", async () => {
    const { client, calls } = makeClient("ca", [submitRoute()]);
    const submission = await client.listings.create(manyInputs(3001));
    expect(calls).toHaveLength(2);
    const chunk0 = calls[0]!.bodyJson as ItemEnvelope;
    const chunk1 = calls[1]!.bodyJson as ItemEnvelope;
    expect(chunk0.NeweggEnvelope.Message.Itemfeed[0]!.Item).toHaveLength(3000);
    expect(chunk1.NeweggEnvelope.Message.Itemfeed[0]!.Item).toHaveLength(1);
    expect(submission.feeds).toHaveLength(2);
    expect(submission.feeds.map((f) => f.chunkIndex)).toEqual([0, 1]);
    // The lone chunk-1 item must map to the SECOND submit's request id, not the first.
    expect(submission.itemAssignments).toHaveLength(3001);
    expect(submission.itemAssignments[3000]).toEqual({
      inputIndex: 3000,
      requestId: "REQ-2",
      chunkIndex: 1,
    });
  });

  it("dedups an identical resubmission via the operation ledger", async () => {
    const { client } = makeClient("ca", [submitRoute()]);
    await client.listings.create(MINIMAL);
    await expect(client.listings.create(MINIMAL)).rejects.toBeInstanceOf(
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
    await expect(client.listings.create(MINIMAL)).rejects.toBeInstanceOf(NeweggFeedSubmissionError);
  });
});
