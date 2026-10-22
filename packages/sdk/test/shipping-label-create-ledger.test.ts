import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryOperationStore,
  IndeterminateOrderWriteError,
  LabelCreateGuardError,
  NeweggApiError,
  type OperationStore,
  type ShippingLabelInput,
  type StoredOperation,
} from "../src/index.js";
import type { MockRoute, RecordedCall } from "../src/testing/index.js";
import { makeClient, paths, TEST_API_KEY, TEST_SECRET_KEY } from "./helpers.js";
import { ORDER_NUMBER, SKU, orderResponse } from "./service-write-helpers.js";

/**
 * Per-order duplicate-purchase ledger of label CREATE (T-6212, ADR 0004): an attempt is recorded
 * before dispatch, stays `submitting` when the outcome is unknown, becomes `submitted` on a
 * confirmed purchase and `failed` only when provably nothing was bought. A new create is refused
 * (nothing sent) while the order has a `submitting` or `submitted` record. No real account is used.
 */
const KEY = `label-create:us:${ORDER_NUMBER}`;
const TRACKING = "1ZTEST0000000000";

const input: ShippingLabelInput = {
  orderNumber: ORDER_NUMBER,
  serviceCode: 101,
  shipFrom: {
    firstName: "Test",
    lastName: "Sender",
    phoneNumber: "5550100",
    address1: "1 Placeholder Way",
    city: "Testville",
    stateCode: "ca",
    zipCode: "90001",
  },
  packages: [
    {
      weightLb: 3.5,
      lengthIn: 12,
      widthIn: 8,
      heightIn: 4,
      items: [{ sellerPartNumber: SKU, quantity: 2 }],
    },
  ],
};

/** The order as Newegg keeps reading it while its status lags: still unshipped. */
function unshippedOrder(overrides: Record<string, unknown> = {}): unknown {
  const base = orderResponse({
    OrderStatus: 0,
    OrderStatusDescription: "Unshipped",
    ShipToCountry: "US",
    ShipToCountryCode: "US",
    ...overrides,
  }) as {
    ResponseBody: { OrderInfoList: Array<{ ItemInfoList: Array<Record<string, unknown>> }> };
  };
  const row = base.ResponseBody.OrderInfoList[0];
  if (row !== undefined) {
    row.ItemInfoList = row.ItemInfoList.map((item) => ({ ...item, ShippedQty: 0, Status: 0 }));
  }
  return base;
}

const orderRoute = (order: () => unknown = () => unshippedOrder()): MockRoute => ({
  method: "PUT",
  pathPattern: paths.orderInfo,
  reply: () => ({ status: 200, body: order() }),
});

const goodPackage = {
  TrackingNumber: TRACKING,
  ProcessResult: "Success",
  Rate: { ShippingAmount: "12.34", SignatureOptions: "0.00", Total: "12.34" },
  ItemList: { Item: { SellerPartNumber: SKU, Quantity: "2" } },
};

const createBody = (pkg: unknown = goodPackage) => ({
  NeweggAPIResponse: {
    IsSuccess: "true",
    ResponseBody: {
      Shipment: {
        OrderNumber: ORDER_NUMBER,
        ShipDate: "2026-10-20 09:30:00",
        PackageList: { Package: pkg },
      },
    },
  },
});

/** A create route answering the given replies in order (the last repeats). */
function createRoute(replies: Array<() => { status: number; body: unknown }>): MockRoute {
  let index = 0;
  return {
    method: "POST",
    pathPattern: paths.shippingLabelCreate,
    reply: () => {
      const reply = replies[Math.min(index, replies.length - 1)]!;
      index++;
      return reply();
    },
  };
}

const ok = () => ({ status: 200, body: createBody() });
const gatewayTimeout = () => ({ status: 504, body: "gateway timeout" });
const sl005 = () => ({
  status: 400,
  body: [{ Code: "SL005", Message: "Each part must ship its entire quantity" }],
});

const posts = (calls: RecordedCall[]): RecordedCall[] => calls.filter((c) => c.method === "POST");

function setup(routes: MockRoute[], operationStore: OperationStore = new InMemoryOperationStore()) {
  return { ...makeClient("us", routes, { operationStore }), operationStore };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("label create ledger", () => {
  it("records `submitting` before dispatch and refuses a second create after a timeout", async () => {
    const store = new InMemoryOperationStore();
    let seenAtDispatch: StoredOperation | undefined;
    const { client, calls } = setup(
      [
        orderRoute(),
        createRoute([
          () => {
            // Read synchronously from inside the (mock) network call: the record must exist already.
            void store.get(KEY).then((op) => (seenAtDispatch = op));
            return gatewayTimeout();
          },
        ]),
      ],
      store,
    );

    const first = await client.shippingLabels.create(input).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(IndeterminateOrderWriteError);
    expect(posts(calls)).toHaveLength(1);
    expect(seenAtDispatch?.state).toBe("submitting");
    expect((await store.get(KEY))?.state).toBe("submitting");

    const preview = await client.shippingLabels.previewCreate(input);
    expect(preview.blockers.join(" ")).toContain("acknowledgePriorAttemptId");
    expect(preview.priorAttempt?.state).toBe("submitting");

    const second = await client.shippingLabels.create(input).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(LabelCreateGuardError);
    expect(posts(calls)).toHaveLength(1);
  });

  it("refuses a second create after a confirmed success while the order still reads unshipped", async () => {
    const { client, calls, operationStore } = setup([orderRoute(), createRoute([ok])]);
    await client.shippingLabels.create(input);
    expect((await operationStore.get(KEY))?.state).toBe("submitted");
    const error = await client.shippingLabels.create(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LabelCreateGuardError);
    expect((error as LabelCreateGuardError).attempt.state).toBe("submitted");
    expect((error as LabelCreateGuardError).orderNumber).toBe(ORDER_NUMBER);
    expect(posts(calls)).toHaveLength(1);
  });

  it("allows a new create after Newegg rejected the request (HTTP 4xx)", async () => {
    const { client, calls, operationStore } = setup([orderRoute(), createRoute([sl005, ok])]);
    const refused = await client.shippingLabels.create(input).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(NeweggApiError);
    expect((await operationStore.get(KEY))?.state).toBe("failed");
    const result = await client.shippingLabels.create(input);
    expect(result.succeededCount).toBe(1);
    expect(posts(calls)).toHaveLength(2);
  });

  it("allows a new create after a connection failure that never dispatched", async () => {
    const refusedConnection = (): never => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    let attempt = 0;
    const route: MockRoute = {
      method: "POST",
      pathPattern: paths.shippingLabelCreate,
      reply: () => {
        attempt++;
        // Every attempt of the first create fails pre-send (3 tries); the next create succeeds.
        if (attempt <= 3) refusedConnection();
        return ok();
      },
    };
    const { client, operationStore } = setup([orderRoute(), route]);
    const failed = await client.shippingLabels.create(input).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(NeweggApiError);
    expect(failed).not.toBeInstanceOf(IndeterminateOrderWriteError);
    expect((await operationStore.get(KEY))?.state).toBe("failed");
    expect((await client.shippingLabels.create(input)).succeededCount).toBe(1);
  });

  it("keeps blocking after an ambiguous reset that may have reached Newegg", async () => {
    const reset: MockRoute = {
      method: "POST",
      pathPattern: paths.shippingLabelCreate,
      reply: () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      },
    };
    const { client, calls, operationStore } = setup([orderRoute(), reset]);
    expect(await client.shippingLabels.create(input).catch((e: unknown) => e)).toBeInstanceOf(
      IndeterminateOrderWriteError,
    );
    expect((await operationStore.get(KEY))?.state).toBe("submitting");
    expect(await client.shippingLabels.create(input).catch((e: unknown) => e)).toBeInstanceOf(
      LabelCreateGuardError,
    );
    expect(posts(calls)).toHaveLength(1);
  });

  it("lets only one of two concurrent creates reach Newegg", async () => {
    const { client, calls } = setup([orderRoute(), createRoute([ok])]);
    const results = await Promise.allSettled([
      client.shippingLabels.create(input),
      client.shippingLabels.create(input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      LabelCreateGuardError,
    );
    expect(posts(calls)).toHaveLength(1);
  });

  it("is shared through the operation store: a second client (a restart) is blocked too", async () => {
    const store = new InMemoryOperationStore();
    const a = setup([orderRoute(), createRoute([gatewayTimeout])], store);
    await a.client.shippingLabels.create(input).catch(() => undefined);
    const b = setup([orderRoute(), createRoute([ok])], store);
    expect(await b.client.shippingLabels.create(input).catch((e: unknown) => e)).toBeInstanceOf(
      LabelCreateGuardError,
    );
    expect(posts(b.calls)).toHaveLength(0);
  });

  it("refuses a different order's record only for that order", async () => {
    const store = new InMemoryOperationStore();
    await store.put("label-create:us:123456789", {
      state: "submitting",
      payloadHash: "x",
      requestIds: ["other"],
      updatedAt: new Date().toISOString(),
    });
    const { client, calls } = setup([orderRoute(), createRoute([ok])], store);
    expect((await client.shippingLabels.create(input)).succeededCount).toBe(1);
    expect(posts(calls)).toHaveLength(1);
  });

  it("does not send when the attempt cannot be recorded, and frees the order again", async () => {
    const real = new InMemoryOperationStore();
    let failPuts = true;
    const flaky: OperationStore = {
      get: (key) => real.get(key),
      put: (key, op) => (failPuts ? Promise.reject(new Error("store down")) : real.put(key, op)),
    };
    const { client, calls } = setup([orderRoute(), createRoute([ok])], flaky);
    const failed = await client.shippingLabels.create(input).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(NeweggApiError);
    expect(String((failed as Error).message)).toContain("nothing was sent");
    expect(posts(calls)).toHaveLength(0);
    failPuts = false;
    expect((await client.shippingLabels.create(input)).succeededCount).toBe(1);
  });

  it("forgets an attempt after 24 hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    const { client, calls } = setup([orderRoute(), createRoute([gatewayTimeout, ok])]);
    await client.shippingLabels.create(input).catch(() => undefined);
    vi.setSystemTime(new Date("2026-10-20T23:00:00Z"));
    expect((await client.shippingLabels.previewCreate(input)).blockers.length).toBeGreaterThan(0);
    vi.setSystemTime(new Date("2026-10-21T01:00:00Z"));
    expect((await client.shippingLabels.previewCreate(input)).blockers).toEqual([]);
    expect((await client.shippingLabels.create(input)).succeededCount).toBe(1);
    expect(posts(calls)).toHaveLength(2);
  });
});

describe("label create ledger: acknowledging a prior attempt", () => {
  async function afterTimeout(order: () => unknown = () => unshippedOrder()) {
    const ctx = setup([orderRoute(order), createRoute([gatewayTimeout, ok, gatewayTimeout, ok])]);
    await ctx.client.shippingLabels.create(input).catch(() => undefined);
    const blocked = await ctx.client.shippingLabels.previewCreate(input);
    return { ...ctx, attemptId: blocked.priorAttempt!.attemptId };
  }

  it("clears exactly the attempt it names, once the order lists no package", async () => {
    const { client, calls, attemptId } = await afterTimeout();
    const preview = await client.shippingLabels.previewCreate(input, {
      acknowledgePriorAttemptId: attemptId,
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings.join(" ")).toContain("acknowledged");
    const result = await client.shippingLabels.create(input, {
      acknowledgePriorAttemptId: attemptId,
    });
    expect(result.succeededCount).toBe(1);
    expect(posts(calls)).toHaveLength(2);
  });

  it("rejects an id that is not the latest attempt", async () => {
    const { client, calls } = await afterTimeout();
    const preview = await client.shippingLabels.previewCreate(input, {
      acknowledgePriorAttemptId: "not-the-attempt",
    });
    expect(preview.blockers.join(" ")).toContain("different attempt");
    const error = await client.shippingLabels
      .create(input, { acknowledgePriorAttemptId: "not-the-attempt" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LabelCreateGuardError);
    expect(posts(calls)).toHaveLength(1);
  });

  it("does not clear while the order already lists a package", async () => {
    let withPackage = false;
    const { client, calls, attemptId } = await afterTimeout(() =>
      unshippedOrder(
        withPackage ? { PackageInfoList: { PackageInfo: { TrackingNumber: TRACKING } } } : {},
      ),
    );
    withPackage = true;
    const preview = await client.shippingLabels.previewCreate(input, {
      acknowledgePriorAttemptId: attemptId,
    });
    expect(preview.blockers.join(" ")).toContain("already lists 1 package");
    expect(
      await client.shippingLabels
        .create(input, { acknowledgePriorAttemptId: attemptId })
        .catch((e: unknown) => e),
    ).toBeInstanceOf(LabelCreateGuardError);
    expect(posts(calls)).toHaveLength(1);
  });

  it("covers only the attempt it saw: a newer attempt blocks the other acknowledged create", async () => {
    const { client, calls, attemptId } = await afterTimeout();
    const options = { acknowledgePriorAttemptId: attemptId };
    const results = await Promise.allSettled([
      client.shippingLabels.create(input, options),
      client.shippingLabels.create(input, options),
    ]);
    expect(posts(calls)).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const stale = await client.shippingLabels.create(input, options).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(LabelCreateGuardError);
    expect(posts(calls)).toHaveLength(2);
  });
});

describe("label create ledger: error text", () => {
  it("holds no credential, and the stored record holds none either", async () => {
    const { client, operationStore } = setup([orderRoute(), createRoute([gatewayTimeout])]);
    await client.shippingLabels.create(input).catch(() => undefined);
    const error = (await client.shippingLabels.create(input).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(LabelCreateGuardError);
    const text =
      JSON.stringify(error) + error.message + JSON.stringify(await operationStore.get(KEY));
    for (const secret of [TEST_API_KEY, TEST_SECRET_KEY]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/authorization|bearer/i);
  });
});
