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

  it("rejects an unknown type or premierOrder on every marketplace before any request", async () => {
    const badTypes: unknown[] = [4, 0, "NWS", "bogus", "", "toString", null, {}];
    const badPremier: unknown[] = [1, "Premier", "", "constructor", null];
    for (const marketplace of ["us", "b2b", "ca"] as const) {
      for (const [field, values] of [
        ["type", badTypes],
        ["premierOrder", badPremier],
      ] as const) {
        for (const bad of values) {
          const fetchSpy = vi.fn(() => {
            throw new Error("fetch must not be called");
          }) as unknown as typeof globalThis.fetch;
          const { client } = makeClient(marketplace, [], { fetch: fetchSpy });
          const error: unknown = await client.orders
            .list({ [field]: bad } as unknown as ListOrdersInput)
            .then(
              () => undefined,
              (e: unknown) => e,
            );
          expect(error, `${marketplace} ${field}=${String(bad)}`).toBeInstanceOf(
            NeweggValidationError,
          );
          expect((error as NeweggValidationError).issues[0]?.path).toBe(field);
          expect(fetchSpy).not.toHaveBeenCalled();
        }
      }
    }
  });

  it("still accepts every documented type and premierOrder value", async () => {
    for (const type of ["all", "sbn", "sbs", "multiChannel"] as const) {
      const { client, calls } = clientFor("ca");
      await client.orders.list({ type });
      expect(criteriaOf(calls).Type).toBe({ all: 0, sbn: 1, sbs: 2, multiChannel: 3 }[type]);
    }
    for (const premierOrder of ["all", "premierOnly", "noPremier"] as const) {
      const { client, calls } = clientFor("us");
      await client.orders.list({ premierOrder });
      expect(criteriaOf(calls).PremierOrder).toBe(
        { all: 0, premierOnly: 1, noPremier: 2 }[premierOrder],
      );
    }
  });

  it("rejects a lastUpdatedAfter string that is not one of the two probed wire formats", async () => {
    const bad = [
      "2026-01-02",
      "2026-01-02T03:04:05Z",
      "2026-01-02 03:04",
      "13/02/2026 03:04:05",
      "2026-13-02 03:04:05",
      "2026-01-02 24:00:00",
      "tomorrow",
      " 2026-01-02 03:04:05",
    ];
    for (const value of bad) {
      const fetchSpy = vi.fn(() => {
        throw new Error("fetch must not be called");
      }) as unknown as typeof globalThis.fetch;
      const { client } = makeClient("ca", [], { fetch: fetchSpy });
      const error: unknown = await client.orders.list({ lastUpdatedAfter: value }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, value).toBeInstanceOf(NeweggValidationError);
      expect((error as NeweggValidationError).issues[0]?.path).toBe("lastUpdatedAfter");
      expect(fetchSpy).not.toHaveBeenCalled();
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

  describe("strict status, date and countryCode validation (T-5948)", () => {
    /** Runs `list` on a client whose fetch throws, returning what the call rejected with. */
    async function rejection(marketplace: NeweggMarketplace, input: unknown) {
      const fetchSpy = vi.fn(() => {
        throw new Error("fetch must not be called");
      }) as unknown as typeof globalThis.fetch;
      const { client } = makeClient(marketplace, [], { fetch: fetchSpy });
      const error: unknown = await client.orders.list(input as ListOrdersInput).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      return error;
    }

    it("rejects an unknown status on every marketplace before any request", async () => {
      const bad: unknown[] = ["unknown", "Shipped", "bogus", "", "toString", 2, null, {}];
      for (const marketplace of ["us", "b2b", "ca"] as const) {
        for (const status of bad) {
          const error = await rejection(marketplace, { status });
          expect(error, `${marketplace} status=${String(status)}`).toBeInstanceOf(
            NeweggValidationError,
          );
          expect((error as NeweggValidationError).issues[0]?.path).toBe("status");
        }
      }
    });

    it("still sends every concrete status", async () => {
      const codes = {
        unshipped: 0,
        partiallyShipped: 1,
        shipped: 2,
        invoiced: 3,
        voided: 4,
        paymentPending: 5,
      } as const;
      for (const [status, code] of Object.entries(codes)) {
        const { client, calls } = clientFor("ca");
        await client.orders.list({ status: status as keyof typeof codes });
        expect(criteriaOf(calls).Status).toBe(code);
      }
    });

    it("rejects dateFrom and dateTo strings that are not a Pacific wall-clock format", async () => {
      const bad: unknown[] = [
        "2026-01-02",
        "2026-01-02T03:04:05Z",
        "2026-01-02 03:04",
        "13/02/2026 03:04:05",
        "tomorrow",
        "",
        " 2026-01-02 03:04:05",
        new Date("not a date"),
        20260102,
      ];
      for (const field of ["dateFrom", "dateTo"] as const) {
        for (const value of bad) {
          const error = await rejection("ca", { [field]: value });
          expect(error, `${field}=${String(value)}`).toBeInstanceOf(NeweggValidationError);
          expect((error as NeweggValidationError).issues[0]?.path).toBe(field);
        }
      }
    });

    it("reports every invalid field in one error", async () => {
      const error = await rejection("ca", {
        status: "bogus",
        dateFrom: "x",
        dateTo: "y",
        lastUpdatedAfter: "z",
        type: "nope",
      });
      expect(error).toBeInstanceOf(NeweggValidationError);
      const paths = (error as NeweggValidationError).issues.map((issue) => issue.path).sort();
      expect(paths).toEqual(["dateFrom", "dateTo", "lastUpdatedAfter", "status", "type"]);
    });

    it("sends valid dateFrom/dateTo strings verbatim and renders a Date as Pacific", async () => {
      const strings = clientFor("ca");
      await strings.client.orders.list({
        dateFrom: "01/01/2020 00:00:00",
        dateTo: "2026-12-31 23:59:59",
      });
      expect(criteriaOf(strings.calls)).toEqual({
        OrderDateFrom: "01/01/2020 00:00:00",
        OrderDateTo: "2026-12-31 23:59:59",
      });
      const dates = clientFor("ca");
      await dates.client.orders.list({
        dateFrom: new Date("2026-06-15T20:30:00.000Z"),
        dateTo: new Date("2026-01-15T20:30:00.000Z"),
      });
      expect(criteriaOf(dates.calls)).toEqual({
        OrderDateFrom: "2026-06-15 13:30:00",
        OrderDateTo: "2026-01-15 12:30:00",
      });
    });

    it("rejects a blank or non-string countryCode on every marketplace (validation wins over unsupported)", async () => {
      for (const marketplace of ["us", "b2b", "ca"] as const) {
        for (const countryCode of ["", "  ", "\t", 840, null]) {
          const error = await rejection(marketplace, { countryCode });
          expect(error, `${marketplace} countryCode=${String(countryCode)}`).toBeInstanceOf(
            NeweggValidationError,
          );
          expect((error as NeweggValidationError).issues[0]?.path).toBe("countryCode");
        }
      }
    });

    it("a non-blank countryCode on ca stays an unsupported-operation error, on us it is sent", async () => {
      expect(await rejection("ca", { countryCode: "USA" })).toBeInstanceOf(
        UnsupportedMarketplaceOperationError,
      );
      const { client, calls } = clientFor("us");
      await client.orders.list({ countryCode: "USA" });
      expect(criteriaOf(calls)).toEqual({ CountryCode: "USA" });
    });
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
    // A defined countryCode counts as set even when blank; orders.list rejects a blank one as
    // invalid input first, so this only matters to direct callers of the assertion.
    expect(() =>
      assertOrderCriteriaSupported(getOrderCriteriaPlatform("ca"), { countryCode: "" }),
    ).toThrow(UnsupportedMarketplaceOperationError);
  });
});
