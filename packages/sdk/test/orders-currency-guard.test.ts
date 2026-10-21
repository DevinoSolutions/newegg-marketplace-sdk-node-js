import { describe, expect, it } from "vitest";
import {
  NeweggConfigurationError,
  NeweggMarketplaceMismatchError,
  type NeweggMarketplace,
} from "../src/index.js";
import { assertOrdersMatchMarketplace } from "../src/platform/order-currency.js";
import { getAdapter } from "../src/platform/index.js";
import { makeClient, paths } from "./helpers.js";

/** Synthetic order numbers; the guard error must never echo them. */
const ORDER_NUMBERS = ["800000001", "800000002", "800000003"];

function order(orderNumber: string, currency: string | undefined): Record<string, unknown> {
  return {
    SellerID: "A006",
    OrderNumber: orderNumber,
    OrderStatus: 2,
    OrderStatusDescription: "Shipped",
    ...(currency === undefined ? {} : { CurrencyCode: currency }),
    OrderTotalAmount: "10.00",
    ItemInfoList: [],
  };
}

function page(currencies: Array<string | undefined>): unknown {
  return {
    IsSuccess: true,
    OperationType: "GetOrderInfoResponse",
    SellerID: "A006",
    ResponseBody: {
      PageInfo: {
        TotalCount: currencies.length,
        TotalPageCount: 1,
        PageIndex: 1,
        PageSize: 100,
      },
      OrderInfoList: currencies.map((currency, i) =>
        order(ORDER_NUMBERS[i] ?? "800000099", currency),
      ),
    },
  };
}

function clientFor(marketplace: NeweggMarketplace, currencies: Array<string | undefined>) {
  return makeClient(marketplace, [
    {
      method: "PUT",
      pathPattern: paths.orderInfo,
      reply: () => ({ status: 200, body: page(currencies) }),
    },
  ]);
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("orders currency guard (T-5911)", () => {
  it("platform adapters declare their expected order currencies", () => {
    expect(getAdapter("ca").expectedOrderCurrencies).toEqual(["CAD"]);
    expect(getAdapter("us").expectedOrderCurrencies).toEqual(["USD"]);
    expect(getAdapter("b2b").expectedOrderCurrencies).toEqual(["USD"]);
  });

  for (const marketplace of ["us", "b2b"] as const) {
    it(`throws when every order on a ${marketplace} page is CAD`, async () => {
      const { client } = clientFor(marketplace, ["CAD", "CAD", "CAD"]);
      const error = await caught(client.orders.list());
      expect(error).toBeInstanceOf(NeweggMarketplaceMismatchError);
      expect(error).toBeInstanceOf(NeweggConfigurationError);
      const mismatch = error as NeweggMarketplaceMismatchError;
      expect(mismatch.expectedMarketplace).toBe(marketplace);
      expect(mismatch.actualMarketplace).toBe("ca");
      expect(mismatch.code).toBe("configuration");
    });
  }

  it("passes USD orders on us and b2b", async () => {
    for (const marketplace of ["us", "b2b"] as const) {
      const result = await clientFor(marketplace, ["USD", "USD"]).client.orders.list();
      expect(result.orders).toHaveLength(2);
    }
  });

  it("passes CAD orders on ca", async () => {
    const result = await clientFor("ca", ["CAD", "CAD"]).client.orders.list();
    expect(result.orders).toHaveLength(2);
  });

  it("throws when every order on a ca page is USD, without guessing the real marketplace", async () => {
    const error = await caught(clientFor("ca", ["USD", "USD"]).client.orders.list());
    expect(error).toBeInstanceOf(NeweggMarketplaceMismatchError);
    expect((error as NeweggMarketplaceMismatchError).expectedMarketplace).toBe("ca");
    expect((error as NeweggMarketplaceMismatchError).actualMarketplace).toBeUndefined();
  });

  it("passes an empty page on every marketplace", async () => {
    for (const marketplace of ["us", "b2b", "ca"] as const) {
      const result = await clientFor(marketplace, []).client.orders.list();
      expect(result.orders).toHaveLength(0);
    }
  });

  it("passes a mixed page (one expected currency among foreign ones)", async () => {
    const result = await clientFor("us", ["CAD", "USD", "CAD"]).client.orders.list();
    expect(result.orders).toHaveLength(3);
  });

  it("passes a page where any order has no currency", async () => {
    const result = await clientFor("us", ["CAD", undefined, "CAD"]).client.orders.list();
    expect(result.orders).toHaveLength(3);
    const allMissing = await clientFor("ca", [undefined, undefined]).client.orders.list();
    expect(allMissing.orders).toHaveLength(2);
  });

  it("compares currency codes case-insensitively", async () => {
    const result = await clientFor("ca", ["cad", " CAD "]).client.orders.list();
    expect(result.orders).toHaveLength(2);
  });

  it("never puts order numbers or credentials in the error", async () => {
    const error = (await caught(clientFor("us", ["CAD", "CAD", "CAD"]).client.orders.list())) as
      NeweggMarketplaceMismatchError | undefined;
    expect(error).toBeInstanceOf(NeweggMarketplaceMismatchError);
    const serialized = `${error?.message} ${JSON.stringify(error?.toJSON())}`;
    for (const orderNumber of ORDER_NUMBERS) expect(serialized).not.toContain(orderNumber);
    expect(serialized).not.toContain("test-api-key");
    expect(serialized).not.toContain("test-secret-key");
    expect(error?.details).toMatchObject({
      reason: "order_currency_mismatch",
      expectedCurrencies: ["USD"],
      observedCurrencies: ["CAD"],
      orderCount: 3,
    });
  });

  it("propagates the error through get and tryGet", async () => {
    const { client } = clientFor("us", ["CAD"]);
    expect(await caught(client.orders.get("800000001"))).toBeInstanceOf(
      NeweggMarketplaceMismatchError,
    );
    expect(await caught(client.orders.tryGet("800000001"))).toBeInstanceOf(
      NeweggMarketplaceMismatchError,
    );
  });

  it("assertOrdersMatchMarketplace is a no-op for an empty list", () => {
    expect(() => assertOrdersMatchMarketplace(getAdapter("us"), [])).not.toThrow();
  });
});
