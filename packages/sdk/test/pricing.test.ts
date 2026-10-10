import { describe, expect, it } from "vitest";
import type { MockRoute } from "../src/testing/index.js";
import {
  NeweggApiError,
  NeweggAuthenticationError,
  NeweggValidationError,
  type ItemIdentifier,
} from "../src/index.js";
import { ITEM_PRICE_SAMPLE, makeClient, paths, US_PRICE_SAMPLE } from "./helpers.js";

const spn = (value: string): ItemIdentifier => ({ type: "sellerPartNumber", value });

const usRoute: MockRoute = {
  method: "PUT",
  pathPattern: paths.usPrice,
  reply: () => ({ status: 200, body: US_PRICE_SAMPLE }),
};

const itemRoute: MockRoute = {
  method: "POST",
  pathPattern: paths.itemPrice,
  reply: () => ({ status: 200, body: ITEM_PRICE_SAMPLE }),
};

/** A B2B/CAN price route that always answers with the given status and body. */
function itemRouteReplying(status: number, body: unknown): MockRoute {
  return { method: "POST", pathPattern: paths.itemPrice, reply: () => ({ status, body }) };
}

describe("pricing.get - US (PUT contentmgmt/item/international/price)", () => {
  it("reads one price per destination country and normalizes string-typed values", async () => {
    const { client, calls } = makeClient("us", [usRoute]);
    const snapshot = await client.pricing.get({ identifier: spn("A006testitem201201021459") });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url.pathname).toBe("/marketplace/contentmgmt/item/international/price");
    expect(calls[0]?.url.searchParams.get("sellerid")).toBe("A006");
    expect(calls[0]?.bodyJson).toEqual({ Type: "1", Value: "A006testitem201201021459" });

    expect(snapshot.marketplace).toBe("us");
    expect(snapshot.itemNumber).toBe("9SIA0060884598");
    expect(snapshot.sellerPartNumber).toBe("A006testitem201201021459");
    expect(snapshot.shippedByNewegg).toBeUndefined();
    expect(snapshot.prices).toHaveLength(3);
    expect(snapshot.prices[0]).toEqual({
      countryCode: "USA",
      currency: "USD",
      currencyInferred: false,
      active: false,
      map: 25.99,
      checkoutMap: false,
      sellingPrice: 20.92,
      freeShipping: true,
      promotions: ["priceLock", "volumeDiscount"],
      limitQuantity: 2,
    });
    expect(snapshot.prices[1]).toMatchObject({ countryCode: "IND", currency: "INR", active: true });
    // The IRL row omits OnPromotion entirely.
    expect(snapshot.prices[2]).toMatchObject({ countryCode: "IRL", promotions: [] });
  });

  it("sends the country filter and the UPC condition, and nothing else", async () => {
    const { client, calls } = makeClient("us", [usRoute]);
    await client.pricing.get({
      identifier: { type: "upc", value: "812674021181", condition: "refurbished" },
      countries: ["USA", "AUS"],
    });
    expect(calls[0]?.bodyJson).toEqual({
      Type: "2",
      Value: "812674021181",
      Condition: 2,
      CountryList: { CountryCode: ["USA", "AUS"] },
    });
  });

  it("accepts a single Price object instead of an array, and numeric wire values", async () => {
    const body = {
      ItemNumber: "9SIA0060884598",
      PriceList: {
        Price: {
          CountryCode: "USA",
          Currency: "USD",
          Active: 1,
          MSRP: 30,
          MAP: 0,
          CheckoutMAP: "1",
          SellingPrice: 20.92,
          EnableFreeShipping: 0,
          OnPromotion: 3,
          LimitQuantity: 500,
        },
      },
    };
    const { client } = makeClient("us", [
      { method: "PUT", pathPattern: paths.usPrice, reply: () => ({ status: 200, body }) },
    ]);
    const snapshot = await client.pricing.get({ identifier: spn("X") });
    expect(snapshot.prices).toEqual([
      {
        countryCode: "USA",
        currency: "USD",
        currencyInferred: false,
        active: true,
        msrp: 30,
        map: 0,
        checkoutMap: true,
        sellingPrice: 20.92,
        freeShipping: false,
        promotions: ["autoAddToCart"],
        limitQuantity: 500,
      },
    ]);
  });

  it("ignores OnPromotion 0 and unknown promotion codes", async () => {
    const body = {
      ItemNumber: "9SIA0060884598",
      PriceList: [
        { CountryCode: "USA", SellingPrice: "1.00", OnPromotion: "0" },
        { CountryCode: "CAN", SellingPrice: "2.00", OnPromotion: "2,4,9,4" },
      ],
    };
    const { client } = makeClient("us", [
      { method: "PUT", pathPattern: paths.usPrice, reply: () => ({ status: 200, body }) },
    ]);
    const snapshot = await client.pricing.get({ identifier: spn("X") });
    expect(snapshot.prices.map((p) => p.promotions)).toEqual([[], ["promotionCode", "combo"]]);
  });

  it("attaches the raw payload only when includeRaw is set", async () => {
    const { client } = makeClient("us", [usRoute]);
    const without = await client.pricing.get({ identifier: spn("X") });
    expect(without.raw).toBeUndefined();
    const withRaw = await client.pricing.get({ identifier: spn("X") }, { includeRaw: true });
    expect(withRaw.raw).toEqual(US_PRICE_SAMPLE);
  });
});

describe.each([
  ["ca", "/marketplace/can/contentmgmt/item/price", "CAD"],
  ["b2b", "/marketplace/b2b/contentmgmt/item/price", "USD"],
] as const)("pricing.get - %s (POST %s)", (marketplace, expectedPath, inferredCurrency) => {
  it("reads the flat record, infers the currency, and sends no country filter", async () => {
    const { client, calls } = makeClient(marketplace, [itemRoute]);
    const snapshot = await client.pricing.get({
      identifier: spn("A006testitem201201021459"),
      countries: ["USA"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe(expectedPath);
    expect(calls[0]?.bodyJson).toEqual({ Type: "1", Value: "A006testitem201201021459" });

    expect(snapshot.marketplace).toBe(marketplace);
    expect(snapshot.itemNumber).toBe("9SIA0060884598");
    expect(snapshot.shippedByNewegg).toBe(true);
    expect(snapshot.prices).toEqual([
      {
        currency: inferredCurrency,
        currencyInferred: true,
        active: false,
        map: 25.99,
        checkoutMap: false,
        sellingPrice: 20.92,
        freeShipping: true,
        promotions: ["priceLock", "volumeDiscount"],
        limitQuantity: 1,
      },
    ]);
  });

  it("prefers a currency Newegg actually sends over the inferred one", async () => {
    const { client } = makeClient(marketplace, [
      itemRouteReplying(200, { ...ITEM_PRICE_SAMPLE, Currency: "EUR" }),
    ]);
    const snapshot = await client.pricing.get({ identifier: spn("X") });
    expect(snapshot.prices[0]).toMatchObject({ currency: "EUR", currencyInferred: false });
  });

  it("sends the UPC condition for UPC identifiers only", async () => {
    const { client, calls } = makeClient(marketplace, [itemRoute]);
    await client.pricing.get({
      identifier: { type: "upc", value: "812674021181", condition: "usedGood" },
    });
    await client.pricing.get({ identifier: { type: "neweggItemNumber", value: "9SIA0060884598" } });
    expect(calls[0]?.bodyJson).toEqual({ Type: "2", Value: "812674021181", Condition: 5 });
    expect(calls[1]?.bodyJson).toEqual({ Type: "0", Value: "9SIA0060884598" });
  });

  it("never touches the mutating inventory-and-price endpoint", async () => {
    const { client, calls } = makeClient(marketplace, [itemRoute]);
    await client.pricing.get({ identifier: spn("X") });
    await client.pricing.getMany({ identifiers: [spn("X"), spn("Y")] });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => !c.url.pathname.includes("inventoryandprice"))).toBe(true);
    expect(calls.every((c) => c.method === "POST")).toBe(true);
  });
});

describe("pricing.get - errors", () => {
  it("throws NeweggApiError with the Newegg code for a JSON-array error body", async () => {
    const { client } = makeClient("ca", [
      itemRouteReplying(400, [{ Code: "CT026", Message: "Item does not exist" }]),
    ]);
    await expect(client.pricing.get({ identifier: spn("NOPE") })).rejects.toMatchObject({
      name: "NeweggApiError",
      neweggErrorCode: "CT026",
    });
  });

  it("maps a plain-text 401 to an authentication error", async () => {
    const { client } = makeClient("ca", [itemRouteReplying(401, "Gateway: Seller Auth failed.")]);
    await expect(client.pricing.get({ identifier: spn("X") })).rejects.toBeInstanceOf(
      NeweggAuthenticationError,
    );
  });

  it("surfaces an XML error body's code", async () => {
    const xml =
      '<?xml version="1.0"?><Errors><Error><Code>CT002</Code>' +
      "<Message>Invalid SellerPartNumber</Message></Error></Errors>";
    const { client } = makeClient("ca", [itemRouteReplying(400, xml)]);
    await expect(client.pricing.get({ identifier: spn("X") })).rejects.toMatchObject({
      neweggErrorCode: "CT002",
    });
  });

  it("tryGet returns undefined for CT026 and CT010 but still throws other codes", async () => {
    for (const code of ["CT026", "CT010"]) {
      const { client } = makeClient("ca", [
        itemRouteReplying(400, [{ Code: code, Message: "not found" }]),
      ]);
      await expect(client.pricing.tryGet({ identifier: spn("X") })).resolves.toBeUndefined();
    }
    const { client } = makeClient("ca", [
      itemRouteReplying(400, [{ Code: "CT002", Message: "Invalid" }]),
    ]);
    await expect(client.pricing.tryGet({ identifier: spn("X") })).rejects.toBeInstanceOf(
      NeweggApiError,
    );
  });

  it("throws NeweggApiError when a 200 carries no price payload", async () => {
    const { client } = makeClient("ca", [itemRouteReplying(200, undefined)]);
    await expect(client.pricing.get({ identifier: spn("X") })).rejects.toBeInstanceOf(
      NeweggApiError,
    );
  });
});

describe("pricing validation (no HTTP call is made)", () => {
  const badInputs: Array<[string, unknown]> = [
    ["empty countries", { identifier: spn("X"), countries: [] }],
    ["lowercase country", { identifier: spn("X"), countries: ["usa"] }],
    ["unknown key", { identifier: spn("X"), warehouses: ["USA"] }],
    ["empty seller part number", { identifier: spn("") }],
  ];

  it.each(badInputs)("get rejects %s", async (_name, input) => {
    const { client, calls } = makeClient("us", []);
    const get = client.pricing.get.bind(client.pricing) as (input: unknown) => Promise<unknown>;
    await expect(get(input)).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });

  it("getMany rejects an empty list and more than 100 identifiers", async () => {
    const { client, calls } = makeClient("us", []);
    await expect(client.pricing.getMany({ identifiers: [] })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    const tooMany = Array.from({ length: 101 }, (_, i) => spn(`SKU-${i}`));
    await expect(client.pricing.getMany({ identifiers: tooMany })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("pricing.getMany (fan-out of single reads)", () => {
  const fanOutReply: MockRoute["reply"] = (req) => {
    const value = (req.bodyJson as { Value: string }).Value;
    if (value === "MISSING") {
      return { status: 400, body: [{ Code: "CT026", Message: "Item not found" }] };
    }
    if (value === "BROKEN") {
      return { status: 400, body: [{ Code: "CT007", Message: "Invalid selling price" }] };
    }
    const body = { ...ITEM_PRICE_SAMPLE, SellerPartNumber: value, ItemNumber: `9SI-${value}` };
    return { status: 200, body };
  };
  const fanOutRoute: MockRoute = {
    method: "POST",
    pathPattern: paths.itemPrice,
    reply: fanOutReply,
  };

  it("de-duplicates, preserves request order, and splits missing from failed", async () => {
    const { client, calls } = makeClient("ca", [fanOutRoute]);
    const batch = await client.pricing.getMany({
      identifiers: [spn("B"), spn("MISSING"), spn("A"), spn("B"), spn("BROKEN")],
    });

    expect(calls).toHaveLength(4); // the duplicate "B" is read once
    expect(batch.marketplace).toBe("ca");
    expect(batch.items.map((i) => i.sellerPartNumber)).toEqual(["B", "A"]);
    expect(batch.totalCount).toBe(2);
    expect(batch.missingIdentifiers).toEqual([spn("MISSING")]);
    expect(batch.failures).toEqual([
      {
        identifier: spn("BROKEN"),
        errorCode: "CT007",
        httpStatus: 400,
        message: expect.any(String),
      },
    ]);
    expect(batch.bySellerPartNumber.get("A")?.itemNumber).toBe("9SI-A");
    expect(batch.byItemNumber.get("9SI-B")?.sellerPartNumber).toBe("B");
  });

  it("treats the same UPC under different conditions as distinct reads", async () => {
    const { client, calls } = makeClient("ca", [fanOutRoute]);
    await client.pricing.getMany({
      identifiers: [
        { type: "upc", value: "812674021181", condition: "new" },
        { type: "upc", value: "812674021181", condition: "refurbished" },
        { type: "upc", value: "812674021181", condition: "new" },
      ],
    });
    expect(calls).toHaveLength(2);
  });

  it("bounds parallelism by options.concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const { client } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.itemPrice,
        reply: async (req) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return fanOutReply(req);
        },
      },
    ]);
    const identifiers = Array.from({ length: 8 }, (_, i) => spn(`SKU-${i}`));
    const batch = await client.pricing.getMany({ identifiers }, { concurrency: 2 });
    expect(batch.items).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("does not swallow credential errors into per-item failures", async () => {
    const { client } = makeClient("ca", [itemRouteReplying(401, "Gateway: Seller Auth failed.")]);
    await expect(
      client.pricing.getMany({ identifiers: [spn("A"), spn("B")] }),
    ).rejects.toBeInstanceOf(NeweggAuthenticationError);
  });

  it("applies the US country filter to every read and collects raw payloads", async () => {
    const { client, calls } = makeClient("us", [usRoute]);
    const batch = await client.pricing.getMany(
      { identifiers: [spn("A"), spn("B")], countries: ["USA"] },
      { includeRaw: true },
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.method).toBe("PUT");
      expect((call.bodyJson as { CountryList: unknown }).CountryList).toEqual({
        CountryCode: ["USA"],
      });
    }
    expect(batch.raw).toEqual([US_PRICE_SAMPLE, US_PRICE_SAMPLE]);
  });
});
