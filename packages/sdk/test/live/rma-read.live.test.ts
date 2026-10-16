import { beforeAll, describe, expect, it } from "vitest";
import type { CourtesyRefundsPage, RmasPage } from "../../src/index.js";
import { liveEnabled, makeLiveClient, marketplace } from "./helpers.js";

/**
 * READ-ONLY live RMA / courtesy refund reads against the REAL Newegg API (contracts §18). Issues
 * a handful of requests in total (one RMA list, one courtesy refund list, one request-status list,
 * plus a get-by-number round trip when an RMA exists) to stay far below the throttles (RMA 1000/hr,
 * refund info 30/min). Identifiers are discovered at runtime, assertions cover SHAPES only, and
 * nothing is printed, so no RMA / order number, customer detail or amount reaches logs or the
 * repo. Most shops have no RMAs: every identifier-dependent test skips cleanly then.
 */
const RANGE = { dateFrom: "2020-01-01", dateTo: "2026-12-31" } as const;

describe.skipIf(!liveEnabled)("live (read-only): RMA and courtesy refund reads", () => {
  let rmas: RmasPage | undefined;
  let refundsPage: CourtesyRefundsPage | undefined;

  beforeAll(async () => {
    const client = makeLiveClient();
    rmas = await client.rma.list({ ...RANGE, pageSize: 5 });
    refundsPage = await client.refunds.list({ ...RANGE, pageSize: 5 });
  });

  it("rma.list returns a normalized page (possibly empty)", () => {
    if (!rmas) throw new Error("beforeAll did not populate an RMA page");
    expect(rmas.marketplace).toBe(marketplace());
    expect(rmas.currency).toBe(marketplace() === "ca" ? "CAD" : "USD");
    expect(Array.isArray(rmas.rmas)).toBe(true);
    expect(typeof rmas.totalCount).toBe("number");
    expect(typeof rmas.totalPageCount).toBe("number");
    for (const rma of rmas.rmas) {
      expect(rma.rmaNumber.length).toBeGreaterThan(0);
      expect(rma.status.length).toBeGreaterThan(0);
      expect(rma.type.length).toBeGreaterThan(0);
      expect(Array.isArray(rma.items)).toBe(true);
    }
  });

  it("rma.get round-trips a real RMA number (skips when the account has none)", async (ctx) => {
    const first = rmas?.rmas[0]?.rmaNumber;
    if (!first) {
      ctx.skip();
      return;
    }
    const rma = await makeLiveClient().rma.get(first);
    expect(rma.rmaNumber).toBe(first);
  });

  it("refunds.list returns a normalized page (possibly empty)", () => {
    if (!refundsPage) throw new Error("beforeAll did not populate a courtesy refund page");
    expect(Array.isArray(refundsPage.refunds)).toBe(true);
    expect(typeof refundsPage.totalCount).toBe("number");
    for (const refund of refundsPage.refunds) {
      expect(refund.courtesyRefundId.length).toBeGreaterThan(0);
      expect(refund.status.length).toBeGreaterThan(0);
      expect(refund.reason.length).toBeGreaterThan(0);
    }
  });

  it("refunds.listRequests returns a normalized result (possibly empty)", async () => {
    const result = await makeLiveClient().refunds.listRequests({ maxCount: 5 });
    expect(Array.isArray(result.requests)).toBe(true);
    for (const request of result.requests) {
      expect(request.requestId.length).toBeGreaterThan(0);
      expect(request.state.length).toBeGreaterThan(0);
    }
  });
});
