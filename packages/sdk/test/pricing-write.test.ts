import { describe, expect, it } from "vitest";
import type { MockRoute, RecordedCall } from "../src/testing/index.js";
import {
  NeweggAuthenticationError,
  NeweggValidationError,
  type ItemIdentifier,
  type PriceUpdate,
} from "../src/index.js";
import { ITEM_PRICE_SAMPLE, makeClient, paths, US_PRICE_SAMPLE } from "./helpers.js";

const spn = (value: string): ItemIdentifier => ({ type: "sellerPartNumber", value });
const caUpdate = (value: string, sellingPrice: number): PriceUpdate => ({
  identifier: spn(value),
  sellingPrice,
});

/**
 * A stateful CA/B2B price book: the write route (PUT inventoryandprice) mutates it, the read
 * route (POST item/price) reflects it. `frozen` SKUs model deactivated items (the write is
 * "accepted" but silently ignored - contracts §6.2).
 */
function priceBook(
  initial: Record<string, number>,
  opts: {
    frozen?: string[];
    writeReply?: (req: RecordedCall) => ReturnType<MockRoute["reply"]>;
  } = {},
): { routes: MockRoute[]; prices: Record<string, number> } {
  const prices = { ...initial };
  const routes: MockRoute[] = [
    {
      method: "PUT",
      pathPattern: paths.itemInventoryAndPrice,
      reply: (req) => {
        if (opts.writeReply) return opts.writeReply(req);
        const body = req.bodyJson as { Value: string; SellingPrice: string };
        if (!opts.frozen?.includes(body.Value)) prices[body.Value] = Number(body.SellingPrice);
        return {
          status: 200,
          body: {
            UpdateInventoryAndPriceResult: {
              ItemNumber: `9SI-${body.Value}`,
              SellerPartNumber: body.Value,
              Result: "1",
              SellingPrice: body.SellingPrice,
            },
          },
        };
      },
    },
    {
      method: "POST",
      pathPattern: paths.itemPrice,
      reply: (req) => {
        const value = (req.bodyJson as { Value: string }).Value;
        const price = prices[value];
        if (price === undefined) {
          return { status: 400, body: [{ Code: "CT026", Message: "Item does not exist" }] };
        }
        return {
          status: 200,
          body: { ...ITEM_PRICE_SAMPLE, SellerPartNumber: value, SellingPrice: price, Active: "1" },
        };
      },
    },
  ];
  return { routes, prices };
}

const isWrite = (call: RecordedCall): boolean =>
  call.url.pathname.includes("inventoryandprice") ||
  (call.method === "POST" && call.url.pathname.endsWith("/international/price"));
const writes = (calls: RecordedCall[]): RecordedCall[] => calls.filter(isWrite);

describe("pricing.update - B2B/CAN (PUT inventoryandprice, price-only subset)", () => {
  it.each(["ca", "b2b"] as const)(
    "%s: sends ONLY Type/Value/SellingPrice and verifies by read-back",
    async (marketplace) => {
      const book = priceBook({ "SKU-1": 25 });
      const { client, calls } = makeClient(marketplace, book.routes);
      const result = await client.pricing.update(caUpdate("SKU-1", 19.9));

      const sent = writes(calls);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.method).toBe("PUT");
      expect(sent[0]?.url.pathname).toBe(
        `/marketplace/${marketplace === "ca" ? "can" : "b2b"}/contentmgmt/item/inventoryandprice`,
      );
      // Exactly these keys: no Inventory, Active, MAP, CheckoutMAP, MSRP, shipping, LimitQuantity.
      expect(sent[0]?.bodyJson).toEqual({ Type: "1", Value: "SKU-1", SellingPrice: "19.90" });

      expect(result.marketplace).toBe(marketplace);
      expect(result).toMatchObject({
        submittedItemCount: 1,
        appliedItemCount: 1,
        failedItemCount: 0,
        unresolvedItemCount: 0,
      });
      expect(result.items).toEqual([
        {
          inputIndex: 0,
          identifier: spn("SKU-1"),
          requestedSellingPrice: 19.9,
          status: "verified",
          observedSellingPrice: 19.9,
        },
      ]);
      expect(book.prices["SKU-1"]).toBe(19.9);
    },
  );

  it("sends the UPC condition for UPC identifiers", async () => {
    const book = priceBook({ "812674021181": 25 });
    const { client, calls } = makeClient("ca", book.routes);
    await client.pricing.update({
      identifier: { type: "upc", value: "812674021181", condition: "refurbished" },
      sellingPrice: 10,
    });
    expect(writes(calls)[0]?.bodyJson).toEqual({
      Type: "2",
      Value: "812674021181",
      Condition: 2,
      SellingPrice: "10.00",
    });
  });

  it("reports a silently-ignored write (deactivated item) as unverified, not applied", async () => {
    const book = priceBook({ "SKU-1": 25 }, { frozen: ["SKU-1"] });
    const { client } = makeClient("ca", book.routes);
    const result = await client.pricing.update(caUpdate("SKU-1", 19.9));
    expect(result.appliedItemCount).toBe(0);
    expect(result.unresolvedItemCount).toBe(1);
    expect(result.items[0]).toMatchObject({ status: "unverified", observedSellingPrice: 25 });
    expect(result.warnings.join(" ")).toContain("unresolved");
  });

  it("verify:false skips the read-back and reports accepted", async () => {
    const book = priceBook({ "SKU-1": 25 });
    const { client, calls } = makeClient("ca", book.routes);
    const result = await client.pricing.update(caUpdate("SKU-1", 19.9), { verify: false });
    expect(calls).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "accepted", observedSellingPrice: 19.9 });
    expect(result.appliedItemCount).toBe(1);
  });

  it("maps Result=0 to failed", async () => {
    const book = priceBook(
      { "SKU-1": 25 },
      {
        writeReply: () => ({
          status: 200,
          body: { UpdateInventoryAndPriceResult: { Result: "0" } },
        }),
      },
    );
    const { client } = makeClient("ca", book.routes);
    const result = await client.pricing.update(caUpdate("SKU-1", 19.9));
    expect(result.items[0]?.status).toBe("failed");
    expect(result.failedItemCount).toBe(1);
  });

  it("keeps going after a per-item rejection and reports the Newegg code", async () => {
    const book = priceBook(
      { A: 10, B: 10 },
      {
        writeReply: (req) => {
          const body = req.bodyJson as { Value: string; SellingPrice: string };
          if (body.Value === "A") {
            return { status: 400, body: [{ Code: "CT019", Message: "Locked for promotion" }] };
          }
          book.prices[body.Value] = Number(body.SellingPrice);
          return { status: 200, body: { Result: "1", SellingPrice: body.SellingPrice } };
        },
      },
    );
    const { client } = makeClient("ca", book.routes);
    const result = await client.pricing.update([caUpdate("A", 5), caUpdate("B", 5)]);
    expect(result.items.map((i) => [i.inputIndex, i.status, i.errorCode])).toEqual([
      [0, "failed", "CT019"],
      [1, "verified", undefined],
    ]);
    expect(result.failedItemCount).toBe(1);
    expect(result.appliedItemCount).toBe(1);
  });

  it("de-duplicates last-write-wins and reports the count", async () => {
    const book = priceBook({ A: 10 });
    const { client, calls } = makeClient("ca", book.routes);
    const result = await client.pricing.update([caUpdate("A", 5), caUpdate("A", 6)]);
    expect(writes(calls)).toHaveLength(1);
    expect(writes(calls)[0]?.bodyJson).toMatchObject({ SellingPrice: "6.00" });
    expect(result.deduplicatedItemCount).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.inputIndex).toBe(1);
  });

  it("round-trips previewUpdate().normalizedUpdates (inputIndex tolerated, then re-derived)", async () => {
    const book = priceBook({ A: 10, B: 10 });
    const { client } = makeClient("ca", book.routes);
    const preview = await client.pricing.previewUpdate([caUpdate("A", 5), caUpdate("B", 6)]);
    const result = await client.pricing.update(preview.normalizedUpdates);
    expect(result.appliedItemCount).toBe(2);
  });
});

describe("pricing.update - ambiguous failures (ADR 0004: retry-safe absolute assignment)", () => {
  it("retries a transient 503 and then succeeds", async () => {
    let attempts = 0;
    const book = priceBook(
      { A: 10 },
      {
        writeReply: (req) => {
          attempts += 1;
          if (attempts < 3) return { status: 503, body: "Service Unavailable" };
          book.prices.A = Number((req.bodyJson as { SellingPrice: string }).SellingPrice);
          return { status: 200, body: { Result: "1" } };
        },
      },
    );
    const { client } = makeClient("ca", book.routes);
    const result = await client.pricing.update(caUpdate("A", 7));
    expect(attempts).toBe(3);
    expect(result.items[0]?.status).toBe("verified");
  });

  it("resolves an ambiguous failure to verified when the read-back shows the new price", async () => {
    const book = priceBook(
      { A: 10 },
      {
        writeReply: () => {
          book.prices.A = 7; // the write landed, but the response was a gateway timeout
          return { status: 504, body: "Gateway Timeout" };
        },
      },
    );
    const { client } = makeClient("ca", book.routes);
    const result = await client.pricing.update(caUpdate("A", 7));
    expect(result.items[0]).toMatchObject({ status: "verified", observedSellingPrice: 7 });
    expect(result.items[0]?.message).toContain("ambiguously");
  });

  it("reports unknown (never throws) when it stays ambiguous", async () => {
    const book = priceBook(
      { A: 10 },
      { writeReply: () => ({ status: 504, body: "Gateway Timeout" }) },
    );
    const { client } = makeClient("ca", book.routes);
    const result = await client.pricing.update(caUpdate("A", 7));
    expect(result.items[0]?.status).toBe("unknown");
    expect(result.unresolvedItemCount).toBe(1);
    expect(result.items[0]?.message).toContain("re-read");
  });

  it("treats a connection reset after dispatch as unknown", async () => {
    const book = priceBook(
      { A: 10 },
      {
        writeReply: () => {
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
        },
      },
    );
    const { client } = makeClient("ca", book.routes);
    const result = await client.pricing.update(caUpdate("A", 7));
    expect(result.items[0]?.status).toBe("unknown");
  });

  it("treats a refused connection (provably unsent) as failed", async () => {
    const book = priceBook(
      { A: 10 },
      {
        writeReply: () => {
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        },
      },
    );
    const { client } = makeClient("ca", book.routes);
    const result = await client.pricing.update(caUpdate("A", 7));
    expect(result.items[0]?.status).toBe("failed");
  });

  it("reports an authentication failure per item (no information is lost by throwing)", async () => {
    const book = priceBook(
      { A: 10 },
      { writeReply: () => ({ status: 401, body: "Gateway: Seller Auth failed." }) },
    );
    const { client } = makeClient("ca", book.routes);
    const result = await client.pricing.update([caUpdate("A", 7)]);
    expect(result.items[0]).toMatchObject({ status: "failed" });
    expect(result.failedItemCount).toBe(1);
  });
});

describe("pricing.update - US (POST international/price, one country row)", () => {
  function usBook(initial: number): { routes: MockRoute[]; state: { price: number } } {
    const state = { price: initial };
    return {
      state,
      routes: [
        {
          method: "POST",
          pathPattern: paths.usPrice,
          reply: (req) => {
            const body = req.bodyJson as {
              PriceList: {
                Price: Array<{ CountryCode: string; Currency: string; SellingPrice: string }>;
              };
            };
            const row = body.PriceList.Price[0];
            state.price = Number(row?.SellingPrice);
            return {
              status: 200,
              body: { ItemNumber: "9SI-1", PriceList: { Price: row } },
            };
          },
        },
        {
          method: "PUT",
          pathPattern: paths.usPrice,
          reply: () => ({
            status: 200,
            body: {
              ItemNumber: "9SI-1",
              SellerPartNumber: "SKU-1",
              PriceList: {
                Price: { CountryCode: "USA", Currency: "USD", SellingPrice: String(state.price) },
              },
            },
          }),
        },
      ],
    };
  }

  it("sends only CountryCode/Currency/SellingPrice and verifies the country row", async () => {
    const book = usBook(30);
    const { client, calls } = makeClient("us", book.routes);
    const result = await client.pricing.update({
      identifier: spn("SKU-1"),
      sellingPrice: 24.5,
      countryCode: "USA",
      currency: "USD",
    });
    const write = calls.find((c) => c.method === "POST");
    expect(write?.url.pathname).toBe("/marketplace/contentmgmt/item/international/price");
    expect(write?.bodyJson).toEqual({
      Type: "1",
      Value: "SKU-1",
      PriceList: { Price: [{ CountryCode: "USA", Currency: "USD", SellingPrice: "24.50" }] },
    });
    // The read-back asks for the same country only.
    const read = calls.find((c) => c.method === "PUT");
    expect((read?.bodyJson as { CountryList: unknown }).CountryList).toEqual({
      CountryCode: ["USA"],
    });
    expect(result.items[0]).toMatchObject({
      status: "verified",
      countryCode: "USA",
      observedSellingPrice: 24.5,
    });
  });
});

describe("pricing update validation (no HTTP call is made)", () => {
  const bad: Array<[string, "us" | "ca", unknown]> = [
    ["price 0", "ca", { identifier: spn("A"), sellingPrice: 0 }],
    ["negative price", "ca", { identifier: spn("A"), sellingPrice: -1 }],
    ["3 decimals", "ca", { identifier: spn("A"), sellingPrice: 1.005 }],
    ["above the Newegg ceiling", "ca", { identifier: spn("A"), sellingPrice: 100000 }],
    ["NaN", "ca", { identifier: spn("A"), sellingPrice: Number.NaN }],
    ["a string price", "ca", { identifier: spn("A"), sellingPrice: "5" }],
    ["unknown key (MAP)", "ca", { identifier: spn("A"), sellingPrice: 5, map: 4 }],
    ["unknown key (active)", "ca", { identifier: spn("A"), sellingPrice: 5, active: true }],
    ["country on CA", "ca", { identifier: spn("A"), sellingPrice: 5, countryCode: "USA" }],
    ["currency on CA", "ca", { identifier: spn("A"), sellingPrice: 5, currency: "CAD" }],
    ["US without country", "us", { identifier: spn("A"), sellingPrice: 5, currency: "USD" }],
    ["US without currency", "us", { identifier: spn("A"), sellingPrice: 5, countryCode: "USA" }],
    [
      "lowercase currency",
      "us",
      { identifier: spn("A"), sellingPrice: 5, countryCode: "USA", currency: "usd" },
    ],
  ];

  it.each(bad)("rejects %s", async (_name, marketplace, input) => {
    const { client, calls } = makeClient(marketplace, []);
    const update = client.pricing.update.bind(client.pricing) as (i: unknown) => Promise<unknown>;
    const preview = client.pricing.previewUpdate.bind(client.pricing) as (
      i: unknown,
    ) => Promise<unknown>;
    await expect(update(input)).rejects.toBeInstanceOf(NeweggValidationError);
    await expect(preview(input)).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });

  it("accepts the boundary prices", async () => {
    const book = priceBook({ A: 1 });
    const { client } = makeClient("ca", book.routes);
    await expect(
      client.pricing.update(caUpdate("A", 0.01), { verify: false }),
    ).resolves.toBeDefined();
    await expect(
      client.pricing.update(caUpdate("A", 99999.99), { verify: false }),
    ).resolves.toBeDefined();
  });

  it("rejects an empty list and more than 100 updates", async () => {
    const { client, calls } = makeClient("ca", []);
    await expect(client.pricing.update([])).rejects.toBeInstanceOf(NeweggValidationError);
    const many = Array.from({ length: 101 }, (_, i) => caUpdate(`S${i}`, 1));
    await expect(client.pricing.update(many)).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });

  it("reports every issue with its inputIndex", async () => {
    const { client } = makeClient("ca", []);
    const error = await client.pricing
      .update([caUpdate("A", 1), caUpdate("B", 0), caUpdate("C", -2)])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggValidationError);
    const indexes = (error as NeweggValidationError).issues.map((i) => i.inputIndex);
    expect(indexes).toEqual(expect.arrayContaining([1, 2]));
    expect(indexes).not.toContain(0);
  });
});

describe("pricing.previewUpdate (reads only)", () => {
  it("never writes, computes the change, and flags a clean item ok", async () => {
    const book = priceBook({ A: 20 });
    const { client, calls } = makeClient("ca", book.routes);
    const preview = await client.pricing.previewUpdate(caUpdate("A", 15));
    expect(calls.every((c) => c.method === "POST" && c.url.pathname.endsWith("/item/price"))).toBe(
      true,
    );
    expect(writes(calls)).toHaveLength(0);
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0]).toMatchObject({
      inputIndex: 0,
      newSellingPrice: 15,
      currentSellingPrice: 20,
      changePercent: -25,
      currency: "CAD",
    });
    expect(book.prices.A).toBe(20);
  });

  it("blocks an unknown item and keeps the others", async () => {
    const book = priceBook({ A: 20 });
    const { client } = makeClient("ca", book.routes);
    const preview = await client.pricing.previewUpdate([caUpdate("A", 15), caUpdate("NOPE", 5)]);
    expect(preview.changes.map((c) => c.status)).toEqual(["warning", "blocked"]);
    expect(preview.changes[1]?.blockers.join(" ")).toContain("not found");
    expect(preview.warnings.join(" ")).toContain("1 update(s) are blocked");
  });

  it("flags inactive, promotion-locked, below-MAP and no-op prices as warnings", async () => {
    const { client } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.itemPrice,
        reply: () => ({
          status: 200,
          body: { ...ITEM_PRICE_SAMPLE, Active: "0", SellingPrice: 30, MAP: 25.99, CheckoutMAP: 0 },
        }),
      },
    ]);
    const lowered = await client.pricing.previewUpdate(caUpdate("A", 20));
    const text = lowered.changes[0]?.warnings.join(" ") ?? "";
    expect(lowered.changes[0]?.status).toBe("warning");
    expect(text).toContain("inactive");
    expect(text).toContain("priceLock");
    expect(text).toContain("below the MAP");
    const same = await client.pricing.previewUpdate(caUpdate("A", 30));
    expect(same.changes[0]?.warnings.join(" ")).toContain("no change");
  });

  it("blocks a price above a known MSRP", async () => {
    const { client } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.itemPrice,
        reply: () => ({ status: 200, body: { ...ITEM_PRICE_SAMPLE, MSRP: 40, SellingPrice: 30 } }),
      },
    ]);
    const preview = await client.pricing.previewUpdate(caUpdate("A", 41));
    expect(preview.changes[0]?.status).toBe("blocked");
    expect(preview.changes[0]?.blockers.join(" ")).toContain("MSRP");
  });

  it("US: blocks a currency that does not match the country's current one", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.usPrice,
        reply: () => ({ status: 200, body: US_PRICE_SAMPLE }),
      },
    ]);
    const preview = await client.pricing.previewUpdate({
      identifier: spn("A"),
      sellingPrice: 10,
      countryCode: "USA",
      currency: "EUR",
    });
    expect(preview.changes[0]?.status).toBe("blocked");
    expect(preview.changes[0]?.blockers.join(" ")).toContain("CT075");
    expect(preview.warnings.join(" ")).toContain("not been verified");
  });

  it("US: blocks a country the item has no row for", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.usPrice,
        reply: () => ({ status: 200, body: US_PRICE_SAMPLE }),
      },
    ]);
    const preview = await client.pricing.previewUpdate({
      identifier: spn("A"),
      sellingPrice: 10,
      countryCode: "JPN",
      currency: "JPY",
    });
    expect(preview.changes[0]?.status).toBe("blocked");
    expect(preview.changes[0]?.blockers.join(" ")).toContain("JPN");
  });

  it("includeCurrentPrice:false performs no HTTP call and marks changes unchecked", async () => {
    const { client, calls } = makeClient("ca", []);
    const preview = await client.pricing.previewUpdate(caUpdate("A", 15), {
      includeCurrentPrice: false,
    });
    expect(calls).toHaveLength(0);
    expect(preview.changes[0]?.status).toBe("unchecked");
    expect(preview.warnings.join(" ")).toContain("not read");
  });

  it("surfaces a read failure as a blocker, but rethrows credential errors", async () => {
    const { client: broken } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.itemPrice,
        reply: () => ({ status: 400, body: [{ Code: "CT007", Message: "Invalid selling price" }] }),
      },
    ]);
    const preview = await broken.pricing.previewUpdate(caUpdate("A", 15));
    expect(preview.changes[0]?.status).toBe("blocked");
    expect(preview.changes[0]?.blockers.join(" ")).toContain("CT007");

    const { client: unauthorized } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.itemPrice,
        reply: () => ({ status: 401, body: "Gateway: Seller Auth failed." }),
      },
    ]);
    await expect(unauthorized.pricing.previewUpdate(caUpdate("A", 15))).rejects.toBeInstanceOf(
      NeweggAuthenticationError,
    );
  });
});
