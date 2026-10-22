import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { callTool, makeEnv, SENTINELS, startHarness, type Harness } from "./helpers.js";

/**
 * Per-order duplicate-purchase guard for label CREATE (T-6212). The single-use previewId only stops
 * ONE preview being applied twice; after a timed-out or successful purchase Newegg's order status
 * can lag and still read "unshipped", so a fresh preview + apply would buy a SECOND label. The
 * server therefore remembers every create attempt per (marketplace, order) and refuses a new one
 * until a human has verified the order. Nothing here touches a real account.
 */
const ORDER_NUMBER = "900000002";
const SKU = "SKU-PLACEHOLDER";
const TRACKING = "1ZTEST0000000000";

const TOOLS = {
  previewCreate: "newegg_shipping_label_preview_create",
  applyCreate: "newegg_shipping_label_apply_create",
  previewReprint: "newegg_shipping_label_preview_reprint",
} as const;

const CREATE = /shippingservice\/shippinglabel\/createshippinglabel/;

const env = (overrides: Record<string, string | undefined> = {}) =>
  makeEnv({
    NEWEGG_MCP_ALLOW_WRITES: "true",
    NEWEGG_MCP_MAX_LABEL_AMOUNT: "unlimited",
    ...overrides,
  });

/** The order as Newegg keeps reading it while its status lags: unshipped, optionally with a package. */
function orderBody(withPackage: boolean): unknown {
  return {
    IsSuccess: true,
    ResponseBody: {
      PageInfo: { TotalCount: 1, TotalPageCount: 1, PageIndex: 1, PageSize: 100 },
      OrderInfoList: [
        {
          OrderNumber: ORDER_NUMBER,
          OrderStatus: 0,
          SalesChannel: 0,
          FulfillmentOption: 0,
          CurrencyCode: "CAD",
          ShipToCountryCode: "CA",
          OrderTotalAmount: "110.00",
          ItemInfoList: [
            { SellerPartNumber: SKU, OrderedQty: 2, ShippedQty: 0, UnitPrice: "50.00", Status: 0 },
          ],
          ...(withPackage
            ? { PackageInfoList: { PackageInfo: { TrackingNumber: TRACKING, ShipCarrier: "UPS" } } }
            : {}),
        },
      ],
    },
  };
}

const successBody = {
  NeweggAPIResponse: {
    IsSuccess: "true",
    ResponseBody: {
      Shipment: {
        OrderNumber: ORDER_NUMBER,
        ShipDate: "2026-10-20 09:30:00",
        PackageList: {
          Package: {
            TrackingNumber: TRACKING,
            ProcessResult: "Success",
            Rate: { ShippingAmount: "12.34", SignatureOptions: "0", Total: "12.34" },
            ItemList: { Item: { SellerPartNumber: SKU, Quantity: "2" } },
          },
        },
      },
    },
  },
};

interface Scenario {
  /** Replies to successive create POSTs; the last entry repeats. */
  creates: Array<{ status: number; body: unknown }>;
  /** Whether the order read already lists a package. */
  orderHasPackage?: () => boolean;
  /** Also answer the estimate request (needed while the label cap is active). */
  estimate?: boolean;
}

function harnessFor(scenario: Scenario, envOverrides = {}): Promise<Harness> {
  let createIndex = 0;
  const routes: MockRoute[] = [
    {
      method: "PUT",
      pathPattern: /ordermgmt\/order\/orderinfo\?/,
      reply: () => ({ status: 200, body: orderBody(scenario.orderHasPackage?.() ?? false) }),
    },
    {
      method: "POST",
      pathPattern: CREATE,
      reply: () => {
        const entry =
          scenario.creates[Math.min(createIndex, scenario.creates.length - 1)] ??
          scenario.creates[0]!;
        createIndex++;
        return entry;
      },
    },
  ];
  if (scenario.estimate === true) {
    routes.push({
      method: "POST",
      pathPattern: /shippingservice\/shippinglabel\/estimateshippinglabel/,
      reply: () => ({
        status: 200,
        body: {
          NeweggAPIResponse: {
            IsSuccess: "true",
            ResponseBody: {
              Shipment: {
                OrderNumber: ORDER_NUMBER,
                PackageList: {
                  Package: {
                    ProcessResult: "Success",
                    EstimatedRate: { EstimatedShippingAmount: "12.34", EstimatedTotal: "12.34" },
                  },
                },
              },
            },
          },
        },
      }),
    });
  }
  return startHarness({ env: env(envOverrides), routes });
}

const posts = (harness: Harness) => harness.calls.filter((call) => call.method === "POST");

const labelArgs = {
  orderNumber: ORDER_NUMBER,
  serviceCode: 112,
  shipFrom: {
    firstName: "Test",
    lastName: "Sender",
    phoneNumber: "5550100",
    address1: "1 Placeholder Way",
    city: "Testville",
    stateCode: "ON",
    zipCode: "M5V 2T6",
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

/** The prior-attempt id a blocked preview reports; the operator passes it back once the order is verified. */
const attemptOf = (preview: { json: Record<string, unknown> }) =>
  preview.json.priorAttempt as { state: string; attemptId: string; atIso: string };

const TIMEOUT = { status: 504, body: "gateway timeout" };
const OK = { status: 200, body: successBody };
const REFUSED = {
  status: 400,
  body: [{ Code: "SL005", Message: "Quantity must be the whole line" }],
};

describe("label create duplicate-purchase guard", () => {
  it("refuses a fresh preview after a timed-out create, even though the order still reads unshipped", async () => {
    const harness = await harnessFor({ creates: [TIMEOUT] });
    try {
      const first = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(first.json.eligible).toBe(true);
      const applied = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: first.json.previewId as string,
      });
      expect(applied.json.errorCode).toBe("order_write_indeterminate");
      expect(posts(harness)).toHaveLength(1);

      const second = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(second.json.eligible).toBe(false);
      expect(second.json.previewId).toBeUndefined();
      expect((second.json.blockers as string[]).join(" ")).toContain("Seller Portal");
      expect(attemptOf(second).state).toBe("submitting");

      // Nothing else can be applied either: no preview exists and no second POST went out.
      expect(posts(harness)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("refuses at apply a preview made before the failed attempt (two previews race)", async () => {
    const harness = await harnessFor({ creates: [TIMEOUT] });
    try {
      const a = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const b = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(a.json.eligible).toBe(true);
      expect(b.json.eligible).toBe(true);

      const appliedA = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: a.json.previewId as string,
      });
      expect(appliedA.json.errorCode).toBe("order_write_indeterminate");

      const appliedB = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: b.json.previewId as string,
      });
      expect(appliedB.isError).toBe(true);
      expect(appliedB.json.errorCode).toBe("label_create_already_attempted");
      expect(appliedB.json.message).toContain("Nothing was sent");
      expect(posts(harness)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("lets only one of two concurrent applies of the same order reach Newegg", async () => {
    const harness = await harnessFor({ creates: [OK] });
    try {
      const a = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const b = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const results = await Promise.all([
        callTool(harness.mcp, TOOLS.applyCreate, { previewId: a.json.previewId as string }),
        callTool(harness.mcp, TOOLS.applyCreate, { previewId: b.json.previewId as string }),
      ]);
      expect(results.filter((result) => !result.isError)).toHaveLength(1);
      expect(
        results.filter((result) => result.json.errorCode === "label_create_already_attempted"),
      ).toHaveLength(1);
      expect(posts(harness)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("refuses a second create after a confirmed success while the order status lags", async () => {
    const harness = await harnessFor({ creates: [OK] });
    try {
      const first = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const spare = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const applied = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: first.json.previewId as string,
      });
      expect(applied.isError).toBe(false);
      expect(posts(harness)).toHaveLength(1);

      const second = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(second.json.eligible).toBe(false);
      expect(second.json.previewId).toBeUndefined();

      const lateApply = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: spare.json.previewId as string,
      });
      expect(lateApply.json.errorCode).toBe("label_create_already_attempted");
      expect(posts(harness)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("allows a retry after a provably-unsent failure (Newegg refused the request)", async () => {
    const harness = await harnessFor({ creates: [REFUSED, OK] });
    try {
      const first = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const refused = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: first.json.previewId as string,
      });
      expect(refused.isError).toBe(true);
      expect(refused.json.neweggErrorCode).toBe("SL005");

      const second = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(second.json.eligible).toBe(true);
      const applied = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: second.json.previewId as string,
      });
      expect(applied.isError).toBe(false);
      expect(posts(harness)).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("cannot be cleared through the MCP: no acknowledgement input, no attempt id, restart is the way", async () => {
    const harness = await harnessFor({ creates: [TIMEOUT, OK] });
    try {
      const first = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const spare = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      await callTool(harness.mcp, TOOLS.applyCreate, { previewId: first.json.previewId as string });

      const blocked = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(blocked.json.eligible).toBe(false);
      // The attempt id is an SDK concept; the MCP never hands it out.
      expect(Object.keys(blocked.json.priorAttempt as object).sort()).toEqual(["atIso", "state"]);
      const text = (blocked.json.blockers as string[]).join(" ");
      expect(text).toContain("Seller Portal");
      expect(text).toContain("restart");
      expect(text).not.toMatch(/acknowledg/i);

      // An agent that guesses the old argument is rejected by the strict input schema.
      const guessed = await callTool(harness.mcp, TOOLS.previewCreate, {
        ...labelArgs,
        acknowledgePriorAttemptId: "anything",
      });
      expect(guessed.isError).toBe(true);
      expect(guessed.json.previewId).toBeUndefined();

      const refused = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: spare.json.previewId as string,
      });
      expect(refused.json.errorCode).toBe("label_create_already_attempted");
      expect(String(refused.json.message)).toContain("restart");
      expect(String(refused.json.message)).not.toMatch(/acknowledg/i);
      expect(posts(harness)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("a blocked apply makes no request at all: no order read and no estimate", async () => {
    // The default label cap is ON, so every preview and apply would normally quote first.
    const harness = await harnessFor(
      { creates: [TIMEOUT, OK], estimate: true },
      {
        NEWEGG_MCP_MAX_LABEL_AMOUNT: "100",
      },
    );
    try {
      const a = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const b = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(b.json.eligible).toBe(true);
      const appliedA = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: a.json.previewId as string,
      });
      expect(appliedA.json.errorCode).toBe("order_write_indeterminate");
      const before = harness.calls.length;
      const appliedB = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: b.json.previewId as string,
      });
      expect(appliedB.json.errorCode).toBe("label_create_already_attempted");
      expect(harness.calls.length).toBe(before);
    } finally {
      await harness.close();
    }
  });

  it("does not touch the reprint path and records nothing for a preview alone", async () => {
    const harness = await harnessFor({ creates: [OK] });
    try {
      for (let i = 0; i < 3; i++) {
        const preview = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
        expect(preview.json.eligible).toBe(true);
      }
      expect(posts(harness)).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("holds no credential or customer text in the refusal", async () => {
    const harness = await harnessFor({ creates: [TIMEOUT] });
    try {
      const first = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const spare = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      await callTool(harness.mcp, TOOLS.applyCreate, { previewId: first.json.previewId as string });
      const refusedPreview = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const refusedApply = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: spare.json.previewId as string,
      });
      expect(refusedApply.json.errorCode).toBe("label_create_already_attempted");
      for (const text of [refusedPreview.text, refusedApply.text]) {
        for (const secret of [SENTINELS.sellerId, SENTINELS.apiKey, SENTINELS.secretKey]) {
          expect(text).not.toContain(secret);
        }
        expect(text).not.toMatch(/authorization|bearer/i);
      }
    } finally {
      await harness.close();
    }
  });
});
