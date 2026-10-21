import { describe, expect, it, vi } from "vitest";
import {
  NeweggValidationError,
  UnsupportedMarketplaceOperationError,
  type ListOrdersInput,
  type NeweggMarketplace,
} from "../src/index.js";
import {
  assertOrderCriteriaSupported,
  getOrderCriteriaPlatform,
} from "../src/platform/order-criteria.js";
import { makeClient, paths } from "./helpers.js";

/** Currency-less empty page: passes the T-5911 currency guard on every marketplace. */
const EMPTY_PAGE = {
  IsSuccess: true,
  OperationType: "GetOrderInfoResponse",
  ResponseBody: { PageInfo: { TotalCount: 0, TotalPageCount: 0, PageIndex: 1, PageSize: 100 } },
};

type Criteria = Record<string, unknown>;

function clientFor(marketplace: NeweggMarketplace) {
  return makeClient(marketplace, [
    {
      method: "PUT",
      pathPattern: paths.orderInfo,
      reply: () => ({ status: 200, body: EMPTY_PAGE }),
    },
  ]);
}

function criteriaOf(calls: ReadonlyArray<{ bodyJson?: unknown }>): Criteria {
  return (calls[0]!.bodyJson as { RequestBody: { RequestCriteria: Criteria } }).RequestBody
    .RequestCriteria;
}

const US_ONLY: Array<[string, ListOrdersInput]> = [
  ["countryCode", { countryCode: "USA" }],
  ["premierOrder", { premierOrder: "premierOnly" }],
  ["premierOrder (all)", { premierOrder: "all" }],
  ['type "nws"', { type: "nws" }],
];

describe("order criteria per marketplace (T-5912)", () => {
  for (const marketplace of ["ca", "b2b"] as const) {
    for (const [label, input] of US_ONLY) {
      it(`${marketplace}: ${label} throws UnsupportedMarketplaceOperationError before any request`, async () => {
        const fetchSpy = vi.fn(() => {
          throw new Error("fetch must not be called");
        }) as unknown as typeof globalThis.fetch;
        const { client } = makeClient(marketplace, [], { fetch: fetchSpy });
        const error: unknown = await client.orders.list(input).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(UnsupportedMarketplaceOperationError);
        expect((error as Error).message).toContain(marketplace);
        expect((error as Error).message).toContain(label.split(" ")[0]!);
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }

    it(`${marketplace}: names every unsupported criterion in one error`, async () => {
      const { client, calls } = clientFor(marketplace);
      const error = (await client.orders
        .list({ countryCode: "USA", premierOrder: "all", type: "nws" })
        .catch((e: unknown) => e)) as UnsupportedMarketplaceOperationError;
      expect(error).toBeInstanceOf(UnsupportedMarketplaceOperationError);
      expect(error.message).toContain("countryCode");
      expect(error.message).toContain("premierOrder");
      expect(error.message).toContain('type "nws"');
      expect(error.details).toMatchObject({ marketplace });
      expect(calls).toHaveLength(0);
    });

    it(`${marketplace}: other type filters are still sent`, async () => {
      const { client, calls } = clientFor(marketplace);
      await client.orders.list({ type: "sbn" });
      expect(criteriaOf(calls).Type).toBe(1);
    });
  }

  it("us: countryCode, premierOrder and type nws are sent", async () => {
    const { client, calls } = clientFor("us");
    await client.orders.list({ countryCode: "USA", premierOrder: "premierOnly", type: "nws" });
    expect(criteriaOf(calls)).toEqual({ CountryCode: "USA", PremierOrder: 1, Type: 4 });
  });

  it("get/tryGet by order number are unaffected on ca", async () => {
    const { client, calls } = clientFor("ca");
    expect(await client.orders.tryGet(123)).toBeUndefined();
    expect(criteriaOf(calls)).toEqual({ OrderNumberList: { OrderNumber: ["123"] } });
  });

  for (const marketplace of ["us", "b2b", "ca"] as const) {
    it(`${marketplace}: lastUpdatedAfter and isInternal appear in the request body`, async () => {
      const { client, calls } = clientFor(marketplace);
      await client.orders.list({ lastUpdatedAfter: "2026-01-02 03:04:05", isInternal: true });
      expect(criteriaOf(calls)).toEqual({ LastUpdatedAfter: "2026-01-02 03:04:05", IsInternal: 1 });
    });

    it(`${marketplace}: isInternal false is sent as 0 and a MM/DD/YYYY string passes verbatim`, async () => {
      const { client, calls } = clientFor(marketplace);
      await client.orders.list({ lastUpdatedAfter: "01/02/2026 03:04:05", isInternal: false });
      expect(criteriaOf(calls)).toEqual({ LastUpdatedAfter: "01/02/2026 03:04:05", IsInternal: 0 });
    });
  }

  it("renders a Date lastUpdatedAfter in Pacific time (PDT and PST)", async () => {
    const summer = clientFor("ca");
    // 20:30:00 UTC on 2026-06-15 is 13:30:00 PDT (UTC-7).
    await summer.client.orders.list({ lastUpdatedAfter: new Date("2026-06-15T20:30:00.000Z") });
    expect(criteriaOf(summer.calls).LastUpdatedAfter).toBe("2026-06-15 13:30:00");
    const winter = clientFor("ca");
    // 20:30:00 UTC on 2026-01-15 is 12:30:00 PST (UTC-8).
    await winter.client.orders.list({ lastUpdatedAfter: new Date("2026-01-15T20:30:00.000Z") });
    expect(criteriaOf(winter.calls).LastUpdatedAfter).toBe("2026-01-15 12:30:00");
  });

  it("omits the new criteria when they are not set", async () => {
    const { client, calls } = clientFor("ca");
    await client.orders.list({ status: "shipped" });
    expect(criteriaOf(calls)).toEqual({ Status: 2 });
  });

  it("rejects an invalid isInternal value before any request", async () => {
    for (const bad of ["true", 1, 0, null]) {
      const { client, calls } = clientFor("ca");
      const error: unknown = await client.orders
        .list({ isInternal: bad as unknown as boolean })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NeweggValidationError);
      expect((error as NeweggValidationError).issues[0]?.path).toBe("isInternal");
      expect(calls).toHaveLength(0);
    }
  });

  it("rejects an invalid lastUpdatedAfter before any request", async () => {
    for (const bad of [new Date("not a date"), "", "  "]) {
      const { client, calls } = clientFor("ca");
      const error: unknown = await client.orders
        .list({ lastUpdatedAfter: bad })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NeweggValidationError);
      expect((error as NeweggValidationError).issues[0]?.path).toBe("lastUpdatedAfter");
      expect(calls).toHaveLength(0);
    }
  });

  it("the capability map matches the 2026-10-21 probes", () => {
    expect(getOrderCriteriaPlatform("us")).toMatchObject({
      countryCode: true,
      premierOrder: true,
      nwsType: true,
    });
    for (const marketplace of ["b2b", "ca"] as const) {
      expect(getOrderCriteriaPlatform(marketplace)).toMatchObject({
        countryCode: false,
        premierOrder: false,
        nwsType: false,
      });
    }
    expect(() => assertOrderCriteriaSupported(getOrderCriteriaPlatform("ca"), {})).not.toThrow();
  });
});
