import { beforeAll, describe, expect, it } from "vitest";
import { UnsupportedMarketplaceOperationError, type OrdersPage } from "../../src/index.js";
import { liveEnabled, makeLiveClient, marketplace } from "./helpers.js";

/**
 * READ-ONLY live order reads against the REAL Newegg API. Lists recent orders, then fetches one
 * order's full detail (`get`) and its lightweight status (`getStatus`) by number — the latter
 * hits a SECOND endpoint, so the order-number round-trip across both is a real cross-endpoint
 * invariant. Skips cleanly when the account has no orders in range. Every call here is a read
 * (`orders.list` / `get` / `getStatus`); there is deliberately NO write test in the live suite,
 * and not-found semantics (empty page, SO003) are covered deterministically by the mocked suite.
 */
const RANGE = { dateFrom: "01/01/2020 00:00:00", dateTo: "12/31/2026 23:59:59" } as const;

describe.skipIf(!liveEnabled)("live (read-only): order reads", () => {
  let page: OrdersPage | undefined;
  let firstOrderNumber: string | undefined;

  beforeAll(async () => {
    const client = makeLiveClient();
    page = await client.orders.list({ ...RANGE, pageSize: 5 });
    firstOrderNumber = page.orders[0]?.orderNumber;
  });

  it("list returns a normalized page of real orders (read-only)", () => {
    if (!page) throw new Error("beforeAll did not populate an orders page");
    expect(page.marketplace).toBe(marketplace());
    expect(Array.isArray(page.orders)).toBe(true);
    expect(typeof page.totalCount).toBe("number");
    expect(typeof page.totalPageCount).toBe("number");
    expect(page.pageSize).toBeGreaterThanOrEqual(1);
    for (const order of page.orders) {
      expect(typeof order.orderNumber).toBe("string");
      expect(order.orderNumber.length).toBeGreaterThan(0);
      // status is a normalized union and must never be empty — unknown wire codes fold to "unknown".
      expect(typeof order.status).toBe("string");
      expect(order.status.length).toBeGreaterThan(0);
      expect(order.amounts).toBeTypeOf("object");
      expect(Array.isArray(order.items)).toBe(true);
      expect(Array.isArray(order.packages)).toBe(true);
      // The CA account only ever has CAD orders; this is the currency tell the SDK guard relies on.
      if (marketplace() === "ca") expect(order.currencyCode).toBe("CAD");
    }
  });

  it("get returns one real order whose number round-trips (read-only)", async (ctx) => {
    if (!firstOrderNumber) {
      ctx.skip();
      return;
    }
    const client = makeLiveClient();
    const order = await client.orders.get(firstOrderNumber);
    expect(order.orderNumber).toBe(firstOrderNumber);
    expect(order.status.length).toBeGreaterThan(0);
    expect(order.amounts).toBeTypeOf("object");
    expect(Array.isArray(order.items)).toBe(true);
  });

  it("getStatus returns a status for the same order via a 2nd endpoint (read-only)", async (ctx) => {
    if (!firstOrderNumber) {
      ctx.skip();
      return;
    }
    const client = makeLiveClient();
    const snapshot = await client.orders.getStatus(firstOrderNumber);
    expect(snapshot.orderNumber).toBe(firstOrderNumber);
    expect(snapshot.marketplace).toBe(marketplace());
    expect(typeof snapshot.status).toBe("string");
    expect(snapshot.status.length).toBeGreaterThan(0);
  });

  it("lastUpdatedAfter filters server-side: far future gives 0 orders, an old date gives them all (read-only)", async () => {
    const client = makeLiveClient();
    // Two reads of the same endpoint with a Pacific wall-clock string (verified wire format, T-5912).
    const future = await client.orders.list({
      lastUpdatedAfter: "2099-01-01 00:00:00",
      pageSize: 1,
    });
    expect(future.totalCount).toBe(0);
    const unfiltered = await client.orders.list({ pageSize: 1 });
    const old = await client.orders.list({ lastUpdatedAfter: "2000-01-01 00:00:00", pageSize: 1 });
    expect(old.totalCount).toBe(unfiltered.totalCount);
    // IsInternal is accepted on every marketplace (semantics unverified, so only acceptance is asserted).
    const flagged = await client.orders.list({ isInternal: false, pageSize: 1 });
    expect(typeof flagged.totalCount).toBe("number");
  });

  it("us-only criteria are refused before any request on ca (read-only, no network)", async (ctx) => {
    if (marketplace() !== "ca") {
      ctx.skip();
      return;
    }
    const client = makeLiveClient();
    let thrown: unknown;
    try {
      await client.orders.list({ countryCode: "USA" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedMarketplaceOperationError);
  });

  it("additional info is a read that answers for a discovered order (us only)", async (ctx) => {
    if (!firstOrderNumber || marketplace() !== "us") {
      ctx.skip();
      return;
    }
    const client = makeLiveClient();
    const page = await client.orders.listAdditionalInfo({
      orderNumbers: [firstOrderNumber],
      pageSize: 1,
    });
    expect(page.marketplace).toBe("us");
    expect(Array.isArray(page.records)).toBe(true);
    for (const record of page.records) expect(typeof record.orderNumber).toBe("string");
  });
});
