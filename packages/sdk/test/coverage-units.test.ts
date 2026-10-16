import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CatalogLookupTimeoutError,
  IndeterminateServiceWriteError,
  NeweggFeedCancelledError,
  NeweggFeedProcessingError,
  NeweggRateLimitError,
  NeweggTimeoutError,
  ReportTimeoutError,
  UnsupportedMarketplaceOperationError,
} from "../src/index.js";
import { parseUpstreamBody, parseUpstreamError } from "../src/errors/parse-upstream.js";
import { classifyTransport, TransportError } from "../src/client/transport.js";
import { parseRateLimitHeaders, rateLimitKey } from "../src/rate-limit/headers.js";
import { buildItemFeedEnvelope, buildUsFeedEnvelope } from "../src/platform/feed-envelope.js";
import {
  extractBatch,
  identifierTypeCode,
  isDefinedItem,
  parseFlatItem,
  parseUsItem,
} from "../src/platform/normalize.js";
import {
  parseFlatPrice,
  parseFlatPriceUpdate,
  parseUsPrice,
  parseUsPriceUpdate,
} from "../src/platform/price.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("error classes", () => {
  it("serializes the subclass-specific fields and defaults retryability", () => {
    const timeout = new CatalogLookupTimeoutError("slow", { requestId: "req-1" });
    expect(timeout.retryable).toBe(true);
    expect(timeout.toJSON()).toMatchObject({ requestId: "req-1", code: "catalog_lookup_timeout" });

    const report = new ReportTimeoutError("slow", { requestId: "req-2", retryable: false });
    expect(report.retryable).toBe(false);
    expect(report.toJSON()).toMatchObject({ requestId: "req-2", code: "report_timeout" });

    expect(new NeweggTimeoutError("t").retryable).toBe(true);
    expect(new NeweggFeedProcessingError("p").code).toBe("feed_processing");
    expect(new NeweggFeedCancelledError("c").code).toBe("feed_cancelled");
    expect(new UnsupportedMarketplaceOperationError("u").code).toBe("unsupported_operation");
  });

  it("IndeterminateServiceWriteError is never retryable and carries guidance", () => {
    const err = new IndeterminateServiceWriteError("unknown outcome", {
      marketplace: "ca",
      operation: "rma.receive",
      submittedAtIso: "2026-01-01T00:00:00.000Z",
      rmaNumber: "RMA-FAKE",
      retryable: true,
    });
    expect(err.retryable).toBe(false);
    expect(err.guidance).toMatch(/before retrying/);
    expect(err.toJSON()).toMatchObject({
      marketplace: "ca",
      operation: "rma.receive",
      rmaNumber: "RMA-FAKE",
    });
    const custom = new IndeterminateServiceWriteError("x", {
      marketplace: "us",
      operation: "refund.issue",
      submittedAtIso: "2026-01-01T00:00:00.000Z",
      guidance: "look first",
    });
    expect(custom.guidance).toBe("look first");
  });
});

describe("parseUpstreamError rate-limit delay derivation", () => {
  it("falls back to the rate-limit reset header when the message has no delay", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const error = parseUpstreamError(429, "", new Headers(), {
      rateLimit: { requestResetAt: new Date("2026-01-01T00:00:30Z") },
    });
    expect(error).toBeInstanceOf(NeweggRateLimitError);
    expect((error as NeweggRateLimitError).retryAfterMs).toBe(30_000);
  });

  it("caps a reset-derived delay at maxRetryAfterMs and ignores a past reset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const capped = parseUpstreamError(429, "", new Headers(), {
      rateLimit: { requestResetAt: new Date("2026-01-01T01:00:00Z") },
      maxRetryAfterMs: 1000,
    }) as NeweggRateLimitError;
    expect(capped.retryAfterMs).toBe(1000);
    const past = parseUpstreamError(429, "", new Headers(), {
      rateLimit: { requestResetAt: new Date("2025-12-31T00:00:00Z") },
    }) as NeweggRateLimitError;
    expect(past.retryAfterMs).toBeUndefined();
  });

  it("classifies DF012 on a non-429 status as a rate limit", () => {
    const error = parseUpstreamError(400, '[{"Code":"DF012","Message":"too fast"}]', new Headers());
    expect(error).toBeInstanceOf(NeweggRateLimitError);
  });

  it("returns no entries for empty bodies and coerces numeric codes", () => {
    expect(parseUpstreamBody(undefined)).toEqual([]);
    expect(parseUpstreamBody("   ")).toEqual([]);
    expect(parseUpstreamBody('{"Code":123,"Message":456}')).toEqual([
      { code: "123", message: "456" },
    ]);
    expect(parseUpstreamBody('{"unrelated":1}')).toEqual([]);
  });
});

describe("classifyTransport", () => {
  it("re-throws caller aborts unchanged and marks other aborts as ambiguous timeouts", () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(classifyTransport(abort, true)).toBe(abort);
    const timeout = classifyTransport(new DOMException("t", "TimeoutError"), false);
    expect(timeout).toBeInstanceOf(TransportError);
    expect(timeout).toMatchObject({ phase: "ambiguous", timeout: true });
  });

  it("treats DNS/connect-refused as pre-send and resets as ambiguous", () => {
    const refused = classifyTransport(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      false,
    );
    expect(refused).toMatchObject({ phase: "pre-send", causeCode: "ECONNREFUSED" });
    const topLevel = classifyTransport(Object.assign(new Error("x"), { code: "ENOTFOUND" }), false);
    expect(topLevel).toMatchObject({ phase: "pre-send", causeCode: "ENOTFOUND" });
    const reset = classifyTransport(
      Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } }),
      false,
    );
    expect(reset).toMatchObject({ phase: "ambiguous", timeout: false, causeCode: "ECONNRESET" });
    expect(classifyTransport("weird", false)).toMatchObject({ phase: "ambiguous" });
  });
});

describe("parseRateLimitHeaders", () => {
  it("returns undefined when no relevant headers are present", () => {
    expect(parseRateLimitHeaders(new Headers({ "content-type": "application/json" }))).toBe(
      undefined,
    );
  });

  it("parses every request and record header", () => {
    const info = parseRateLimitHeaders(
      new Headers({
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "7",
        "x-ratelimit-resettime": "2026-01-01T00:00:00Z",
        "x-recordcount-limit": "1000",
        "x-recordcount-remaining": "10",
        "x-recordcount-resettime": "2026-01-01T01:00:00Z",
      }),
    );
    expect(info).toMatchObject({
      requestLimit: 100,
      requestRemaining: 7,
      recordLimit: 1000,
      recordRemaining: 10,
    });
    expect(info?.requestResetAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(info?.recordResetAt?.toISOString()).toBe("2026-01-01T01:00:00.000Z");
  });

  it("ignores unparseable numbers and dates", () => {
    expect(
      parseRateLimitHeaders(
        new Headers({ "x-ratelimit-limit": "abc", "x-ratelimit-resettime": "nonsense" }),
      ),
    ).toBeUndefined();
  });

  it("builds a stable store key", () => {
    expect(rateLimitKey("ca", "SELLER", "inventory.get")).toBe("ca:SELLER:inventory.get");
  });
});

describe("feed envelopes", () => {
  const items = [
    {
      sellerPartNumber: "SKU-1",
      neweggItemNumber: "N82E-FAKE",
      warehouseLocation: "CA",
      quantity: 5,
    },
    { sellerPartNumber: "SKU-2", quantity: 0 },
  ];

  it("US envelope: Item is an array, fulfillment is always Seller, quantity is a string", () => {
    const env = buildUsFeedEnvelope(items) as {
      NeweggEnvelope: { Header: unknown; Message: { Inventory: { Item: unknown[] } } };
    };
    expect(env.NeweggEnvelope.Header).toEqual({ DocumentVersion: "2.0" });
    expect(env.NeweggEnvelope.Message.Inventory.Item).toEqual([
      {
        SellerPartNumber: "SKU-1",
        NeweggItemNumber: "N82E-FAKE",
        WarehouseLocation: "CA",
        FulfillmentOption: "Seller",
        Inventory: "5",
      },
      {
        SellerPartNumber: "SKU-2",
        WarehouseLocation: undefined,
        FulfillmentOption: "Seller",
        Inventory: "0",
      },
    ]);
  });

  it("B2B/CA envelope hard-codes Overwrite=No and omits an absent item number", () => {
    const env = buildItemFeedEnvelope(items) as {
      NeweggEnvelope: { Overwrite: string; Message: { Inventory: { Item: unknown[] } } };
    };
    expect(env.NeweggEnvelope.Overwrite).toBe("No");
    expect(JSON.stringify(env)).not.toContain('"Yes"');
    expect(env.NeweggEnvelope.Message.Inventory.Item).toEqual([
      { SellerPartNumber: "SKU-1", NeweggItemNumber: "N82E-FAKE", Inventory: "5" },
      { SellerPartNumber: "SKU-2", Inventory: "0" },
    ]);
  });
});

describe("inventory normalization", () => {
  it("maps identifier types to Newegg codes", () => {
    expect(identifierTypeCode("neweggItemNumber")).toBe("0");
    expect(identifierTypeCode("sellerPartNumber")).toBe("1");
    expect(identifierTypeCode("upc")).toBe("2");
  });

  it("rejects non-record and empty flat items", () => {
    expect(parseFlatItem("nope")).toBeUndefined();
    expect(parseFlatItem({})).toBeUndefined();
    expect(parseUsItem(null)).toBeUndefined();
    expect(isDefinedItem(undefined)).toBe(false);
  });

  it("flat item: object-or-array warehouse breakdown, missing quantities default to 0", () => {
    const single = parseFlatItem({
      ItemNumber: "N82E-FAKE",
      AvailableQuantity: "4",
      FulfillmentOption: "1",
      Active: "1",
      WarehouseAllocation: { Warehouse: { WarehouseCode: "W1", Quantity: "2" } },
    });
    expect(single?.warehouses).toEqual([
      { location: "default", quantity: 4, fulfillment: "newegg" },
      { location: "W1", quantity: 2, fulfillment: "newegg" },
    ]);
    const many = parseFlatItem({
      SellerPartNumber: "SKU",
      WarehouseAllocation: { Warehouse: [{ WarehouseCode: "W1" }, { Quantity: "9" }] },
    });
    expect(many?.totalAvailableQuantity).toBe(0);
    expect(many?.warehouses).toEqual([
      { location: "default", quantity: 0, fulfillment: "seller" },
      { location: "W1", quantity: 0, fulfillment: "seller" },
    ]);
  });

  it("extractBatch tolerates a bare body, a single item, and no list", () => {
    expect(extractBatch({ ItemList: { ItemNumber: "x" }, TotalCount: "1" })).toEqual({
      itemsRaw: [{ ItemNumber: "x" }],
      totalCount: 1,
    });
    expect(
      extractBatch({ ResponseBody: { ItemList: [{ a: 1 }, { a: 2 }], TotalCount: 2 } }),
    ).toEqual({ itemsRaw: [{ a: 1 }, { a: 2 }], totalCount: 2 });
    expect(extractBatch({})).toEqual({ itemsRaw: [], totalCount: undefined });
  });
});

describe("price normalization", () => {
  it("US price: object-or-array Price rows and a bare PriceList array", () => {
    const single = parseUsPrice({
      ItemNumber: "N82E-FAKE",
      PriceList: { Price: { CountryCode: "USA", SellingPrice: "9.99", OnPromotion: "1,5,5,0,9" } },
    });
    expect(single?.entries).toHaveLength(1);
    expect(single?.entries[0]).toMatchObject({
      countryCode: "USA",
      sellingPrice: 9.99,
      promotions: ["priceLock", "volumeDiscount"],
    });
    const bare = parseUsPrice({
      SellerPartNumber: "SKU",
      PriceList: [{ CountryCode: "USA" }, "junk", { CountryCode: "CAN" }],
    });
    expect(bare?.entries.map((e) => e.countryCode)).toEqual(["USA", "CAN"]);
  });

  it("returns undefined for empty or non-object price payloads", () => {
    expect(parseUsPrice("x")).toBeUndefined();
    expect(parseUsPrice({})).toBeUndefined();
    expect(parseFlatPrice([])).toBeUndefined();
    expect(parseFlatPrice({})).toBeUndefined();
  });

  it("US price update picks the updated country row, tolerating a bare array", () => {
    expect(
      parseUsPriceUpdate(
        {
          ItemNumber: "N",
          PriceList: {
            Price: [
              { CountryCode: "USA", SellingPrice: "1" },
              { CountryCode: "CAN", SellingPrice: "2" },
            ],
          },
        },
        "CAN",
      ).sellingPrice,
    ).toBe(2);
    expect(
      parseUsPriceUpdate({ PriceList: [{ CountryCode: "USA", SellingPrice: "3" }] }, "USA")
        .sellingPrice,
    ).toBe(3);
    expect(parseUsPriceUpdate({}, "USA").sellingPrice).toBeUndefined();
  });

  it("flat price update reads the wrapped or flat result", () => {
    expect(
      parseFlatPriceUpdate({
        UpdateInventoryAndPriceResult: { ItemNumber: "N", Result: "1", SellingPrice: "5.5" },
      }),
    ).toMatchObject({ itemNumber: "N", success: true, sellingPrice: 5.5 });
    expect(parseFlatPriceUpdate({ SellerPartNumber: "S", Result: "0" })).toMatchObject({
      sellerPartNumber: "S",
      success: false,
    });
  });
});
