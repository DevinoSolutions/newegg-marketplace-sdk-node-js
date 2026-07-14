import { beforeAll, describe, expect, it } from "vitest";
import type { OrdersPage } from "../../src/index.js";
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
});
