import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import type { PreviewRecord } from "../src/index.js";
import {
  hashItemsPreview,
  hashLabelPreview,
  hashServicePreview,
  type PreviewSeal,
} from "../src/tools/preview-hash.js";
import { callTool, makeEnv, startHarness, type Harness } from "./helpers.js";
import { ORDER_NUMBER, SKU, orderBody, readRoutes } from "./service-write-fixtures.js";

// T-6215: a forged store record for the kinds that move money or send feeds (volume discount,
// shipping label, RMA) must be refused at apply whether the forger recomputes the public sha-256
// or seals it with some other key: preview_tampered, and zero writes.

const writesEnv = () =>
  makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true", NEWEGG_MCP_MAX_LABEL_AMOUNT: "unlimited" });

const sha256Of = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

const FOREIGN_KEY = Buffer.from("a-key-the-forger-picked-0123456789abcdef", "utf8");

/** The seal a forger would use: their own key, but the real id, session and expiry of the record. */
const foreignSeal = (record: PreviewRecord): PreviewSeal => ({
  key: FOREIGN_KEY,
  previewId: record.previewId,
  sessionId: record.sessionId,
  expiresAt: record.expiresAt,
});

/** Store records are readonly in the types; a forger in the store is not bound by that. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type Forge = "plain sha-256" | "mac under another key";
const FORGES: Forge[] = ["plain sha-256", "mac under another key"];

type Call = Harness["calls"][number];
const writes = (harness: Harness, isWrite: (call: Call) => boolean) =>
  harness.calls.filter(isWrite);

const feedSubmit: MockRoute = {
  method: "POST",
  pathPattern: "datafeedmgmt/feeds/submitfeed",
  reply: () => ({
    status: 200,
    body: {
      IsSuccess: true,
      ResponseBody: { ResponseList: [{ RequestId: "REQ-9", RequestStatus: "SUBMITTED" }] },
    },
  }),
};
const isFeedSubmit = (call: Call) =>
  call.method === "POST" && call.url.pathname.includes("submitfeed");

describe("volume discount: a forged record is refused (T-6215)", () => {
  it.each(FORGES)("%s", async (forge) => {
    const harness = await startHarness({ env: writesEnv(), routes: [feedSubmit] });
    try {
      const preview = await callTool(harness.mcp, "newegg_volume_discount_preview_update", {
        items: [
          {
            neweggItemNumber: "9SIAFAKE0000001",
            sellerPartNumber: "FAKE-SKU-1",
            tiers: [{ quantity: 5, sellingPrice: 95.5, freeShipping: true }],
          },
        ],
      });
      expect(preview.isError).toBe(false);
      const id = preview.json.previewId as string;
      const stored = (await harness.previewStore.get(id)) as unknown as Mutable<
        Extract<PreviewRecord, { kind: "volumeDiscountUpdate" }>
      >;
      const tier = stored.items[0]?.tiers[0];
      if (tier === undefined) throw new Error("expected a stored tier");
      tier.sellingPrice = 1;
      stored.hash =
        forge === "plain sha-256"
          ? sha256Of({ kind: stored.kind, marketplace: stored.marketplace, items: stored.items })
          : hashItemsPreview(foreignSeal(stored), stored.kind, stored.marketplace, stored.items);
      const applied = await callTool(harness.mcp, "newegg_volume_discount_apply_update", {
        previewId: id,
      });
      expect(applied.isError).toBe(true);
      expect(applied.json.errorCode).toBe("preview_tampered");
      expect(writes(harness, isFeedSubmit)).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("shipping label: a forged record is refused (T-6215)", () => {
  const orderRoute: MockRoute = {
    method: "PUT",
    pathPattern: /ordermgmt\/order\/orderinfo\?/,
    reply: () => ({ status: 200, body: orderBody({ OrderStatus: 0 }) }),
  };
  const createRoute: MockRoute = {
    method: "POST",
    pathPattern: /shippingservice\/shippinglabel\/createshippinglabel/,
    reply: () => ({ status: 200, body: {} }),
  };
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

  it.each(FORGES)("%s", async (forge) => {
    const harness = await startHarness({ env: writesEnv(), routes: [orderRoute, createRoute] });
    try {
      const preview = await callTool(
        harness.mcp,
        "newegg_shipping_label_preview_create",
        labelArgs,
      );
      expect(preview.isError).toBe(false);
      const id = preview.json.previewId as string;
      const stored = (await harness.previewStore.get(id)) as unknown as Mutable<
        Extract<PreviewRecord, { kind: "shippingLabelCreate" }>
      > & { input: { serviceCode: number } };
      stored.input.serviceCode = 114;
      stored.hash =
        forge === "plain sha-256"
          ? sha256Of({
              kind: stored.kind,
              marketplace: stored.marketplace,
              input: stored.input,
              costCents: stored.costCents ?? null,
            })
          : hashLabelPreview(
              foreignSeal(stored),
              stored.kind,
              stored.marketplace,
              stored.input,
              stored.costCents,
            );
      const applied = await callTool(harness.mcp, "newegg_shipping_label_apply_create", {
        previewId: id,
      });
      expect(applied.isError).toBe(true);
      expect(applied.json.errorCode).toBe("preview_tampered");
      expect(harness.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("RMA: a forged record is refused (T-6215)", () => {
  const submitArgs = {
    orderNumber: ORDER_NUMBER,
    type: "refund",
    note: "faulty",
    items: [
      {
        sellerPartNumber: SKU,
        returnQuantity: 1,
        reason: "defective",
        returnUnitPrice: 40,
        refundShippingPrice: 0,
      },
    ],
  };
  const newRma: MockRoute = {
    method: "POST",
    pathPattern: /servicemgmt\/rma\/newrma/,
    reply: () => ({ status: 200, body: {} }),
  };

  it.each(FORGES)("%s", async (forge) => {
    const harness = await startHarness({
      env: writesEnv(),
      routes: [...readRoutes({}), newRma],
    });
    try {
      const preview = await callTool(harness.mcp, "newegg_rma_preview_submit", submitArgs);
      expect(preview.isError).toBe(false);
      const id = preview.json.previewId as string;
      const stored = (await harness.previewStore.get(id)) as unknown as Mutable<
        Extract<PreviewRecord, { kind: "rmaSubmit" }>
      > & { input: { items: Array<{ returnUnitPrice: number }> } };
      const item = stored.input.items[0];
      if (item === undefined) throw new Error("expected a stored item");
      item.returnUnitPrice = 90;
      stored.hash =
        forge === "plain sha-256"
          ? sha256Of({
              kind: stored.kind,
              marketplace: stored.marketplace,
              input: stored.input,
              refundCents: stored.refundCents ?? null,
            })
          : hashServicePreview(
              foreignSeal(stored),
              stored.kind,
              stored.marketplace,
              stored.input,
              stored.refundCents,
            );
      const applied = await callTool(harness.mcp, "newegg_rma_apply_submit", { previewId: id });
      expect(applied.isError).toBe(true);
      expect(applied.json.errorCode).toBe("preview_tampered");
      expect(harness.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
