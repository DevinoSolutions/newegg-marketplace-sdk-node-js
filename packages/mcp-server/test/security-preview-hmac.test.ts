import { describe, expect, it } from "vitest";
import {
  InMemoryPreviewStore,
  loadMcpConfigFromEnv,
  McpConfigError,
  type PreviewRecord,
} from "../src/index.js";
import {
  hashInventoryPreview,
  hashItemsPreview,
  hashLabelPreview,
  hashServicePreview,
  previewHashMatches,
  previewKeyFor,
  type PreviewSeal,
} from "../src/tools/preview-hash.js";
import { callTool, inventoryAndPriceRoute, makeEnv, startHarness } from "./helpers.js";

// T-6218: the stored hash is an HMAC under NEWEGG_MCP_PREVIEW_HMAC_KEY (or a per-process random key).

const KEY_A = "preview-hmac-key-A-0123456789abcdefghij";
const KEY_B = "preview-hmac-key-B-0123456789abcdefghij";

const envWith = (key: string | undefined) =>
  makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true", NEWEGG_MCP_PREVIEW_HMAC_KEY: key });

const PREVIEW_ARGS = {
  updates: [{ identifier: { type: "sellerPartNumber", value: "A" }, quantity: 7 }],
};

describe("NEWEGG_MCP_PREVIEW_HMAC_KEY validation", () => {
  it("accepts a strong key and keys the MAC with it", () => {
    const config = loadMcpConfigFromEnv(envWith(KEY_A));
    expect(config.previewIntegrity?.hmacKey).toBe(KEY_A);
    expect(previewKeyFor(config).equals(Buffer.from(KEY_A, "utf8"))).toBe(true);
  });

  it("falls back to a stable per-process random key when unset or blank", () => {
    const unset = loadMcpConfigFromEnv(envWith(undefined));
    const blank = loadMcpConfigFromEnv(envWith("   "));
    expect(unset.previewIntegrity?.hmacKey).toBeUndefined();
    expect(blank.previewIntegrity?.hmacKey).toBeUndefined();
    const key = previewKeyFor(unset);
    expect(key).toHaveLength(32);
    expect(previewKeyFor(blank).equals(key)).toBe(true);
  });

  it.each([
    ["too short", "short-key"],
    ["too few distinct characters", "ab".repeat(20)],
  ])("rejects a key that is %s without echoing it", (_label, weak) => {
    let thrown: unknown;
    try {
      loadMcpConfigFromEnv(envWith(weak));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpConfigError);
    const message = (thrown as Error).message;
    expect(message).toContain("NEWEGG_MCP_PREVIEW_HMAC_KEY");
    expect(message).not.toContain(weak);
  });

  it("never serializes the key", () => {
    const config = loadMcpConfigFromEnv(envWith(KEY_A));
    expect(JSON.stringify(config)).not.toContain(KEY_A);
  });
});

describe("a store shared by two servers", () => {
  it("applies a preview created by another server that has the same key", async () => {
    const store = new InMemoryPreviewStore();
    const a = await startHarness({
      env: envWith(KEY_A),
      routes: [inventoryAndPriceRoute()],
      previewStore: store,
    });
    const b = await startHarness({
      env: envWith(KEY_A),
      routes: [inventoryAndPriceRoute()],
      previewStore: store,
    });
    try {
      const preview = await callTool(a.mcp, "newegg_inventory_preview_update", PREVIEW_ARGS);
      const applied = await callTool(b.mcp, "newegg_inventory_apply_update", {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(false);
      expect(b.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("refuses (fails closed) a preview sealed under a different key", async () => {
    const store = new InMemoryPreviewStore();
    const a = await startHarness({
      env: envWith(KEY_A),
      routes: [inventoryAndPriceRoute()],
      previewStore: store,
    });
    const b = await startHarness({
      env: envWith(KEY_B),
      routes: [inventoryAndPriceRoute()],
      previewStore: store,
    });
    try {
      const preview = await callTool(a.mcp, "newegg_inventory_preview_update", PREVIEW_ARGS);
      const applied = await callTool(b.mcp, "newegg_inventory_apply_update", {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(true);
      expect(applied.json.errorCode).toBe("preview_tampered");
      expect(applied.text).toContain("NEWEGG_MCP_PREVIEW_HMAC_KEY");
      expect(b.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("refuses a preview sealed under the configured key when the other server has none", async () => {
    const store = new InMemoryPreviewStore();
    const keyed = await startHarness({
      env: envWith(KEY_A),
      routes: [inventoryAndPriceRoute()],
      previewStore: store,
    });
    const unkeyed = await startHarness({
      env: envWith(undefined),
      routes: [inventoryAndPriceRoute()],
      previewStore: store,
    });
    try {
      const preview = await callTool(keyed.mcp, "newegg_inventory_preview_update", PREVIEW_ARGS);
      const applied = await callTool(unkeyed.mcp, "newegg_inventory_apply_update", {
        previewId: preview.json.previewId as string,
      });
      expect(applied.json.errorCode).toBe("preview_tampered");
      expect(unkeyed.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    } finally {
      await keyed.close();
      await unkeyed.close();
    }
  });
});

describe("previewHashMatches", () => {
  const key = Buffer.from(KEY_A, "utf8");
  const expiresAt = new Date("2026-01-01T00:10:00Z");
  const seal = (overrides: Partial<PreviewSeal> = {}): PreviewSeal => ({
    key,
    previewId: "p-1",
    sessionId: "s-1",
    expiresAt,
    ...overrides,
  });
  const base = {
    previewId: "p-1",
    sessionId: "s-1",
    marketplace: "ca",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt,
  } as const;

  const label = (hash: string, input: unknown = { orderNumber: "1" }): PreviewRecord =>
    ({
      ...base,
      kind: "shippingLabelCreate",
      hash,
      input,
      costCents: 1250,
    }) as unknown as PreviewRecord;

  const refund = (hash: string, input: unknown = { amount: 5 }): PreviewRecord =>
    ({ ...base, kind: "courtesyRefundIssue", hash, input, refundCents: 500 }) as PreviewRecord;

  it("accepts a shipping-label record and refuses an altered input, cost or foreign key", () => {
    const hash = hashLabelPreview(seal(), "shippingLabelCreate", "ca", { orderNumber: "1" }, 1250);
    expect(previewHashMatches(key, label(hash))).toBe(true);
    expect(previewHashMatches(key, label(hash, { orderNumber: "2" }))).toBe(false);
    expect(
      previewHashMatches(key, { ...label(hash), costCents: 1 } as unknown as PreviewRecord),
    ).toBe(false);
    expect(previewHashMatches(Buffer.from(KEY_B, "utf8"), label(hash))).toBe(false);
  });

  it("accepts an RMA / refund record and refuses an altered input or amount", () => {
    const hash = hashServicePreview(seal(), "courtesyRefundIssue", "ca", { amount: 5 }, 500);
    expect(previewHashMatches(key, refund(hash))).toBe(true);
    expect(previewHashMatches(key, refund(hash, { amount: 6 }))).toBe(false);
    expect(previewHashMatches(key, { ...refund(hash), refundCents: 600 } as PreviewRecord)).toBe(
      false,
    );
  });

  it("binds previewId, sessionId and expiresAt", () => {
    const hash = hashServicePreview(seal(), "courtesyRefundIssue", "ca", { amount: 5 }, 500);
    expect(previewHashMatches(key, { ...refund(hash), previewId: "p-2" } as PreviewRecord)).toBe(
      false,
    );
    expect(previewHashMatches(key, { ...refund(hash), sessionId: "s-2" } as PreviewRecord)).toBe(
      false,
    );
    expect(
      previewHashMatches(key, { ...refund(hash), sessionId: undefined } as PreviewRecord),
    ).toBe(false);
    expect(
      previewHashMatches(key, {
        ...refund(hash),
        expiresAt: new Date(expiresAt.getTime() + 1),
      } as PreviewRecord),
    ).toBe(false);
  });

  it("fails closed on a malformed record instead of throwing", () => {
    const hash = hashInventoryPreview(seal(), "ca", "direct", []);
    const inventory = {
      ...base,
      kind: "inventoryUpdate",
      hash,
      strategy: "direct",
      normalizedUpdates: [],
    } as unknown as PreviewRecord;
    expect(previewHashMatches(key, inventory)).toBe(true);
    const missing = { ...inventory, normalizedUpdates: undefined } as unknown as PreviewRecord;
    expect(previewHashMatches(key, missing)).toBe(false);
    expect(previewHashMatches(key, { ...inventory, hash: 42 } as unknown as PreviewRecord)).toBe(
      false,
    );
    expect(previewHashMatches(key, { ...inventory, hash: "" } as PreviewRecord)).toBe(false);
    expect(
      previewHashMatches(key, { ...inventory, kind: "nope" } as unknown as PreviewRecord),
    ).toBe(false);
    expect(
      previewHashMatches(key, { ...inventory, expiresAt: "soon" } as unknown as PreviewRecord),
    ).toBe(false);
  });
});

describe("pricing apply tool description", () => {
  it("tells the caller that apply re-reads live prices and refuses with preview_stale on drift", async () => {
    const harness = await startHarness({
      env: envWith(undefined),
      routes: [inventoryAndPriceRoute()],
    });
    try {
      const { tools } = await harness.mcp.listTools();
      const apply = tools.find((tool) => tool.name === "newegg_pricing_apply_update");
      expect(apply?.description).toMatch(/re-reads/);
      expect(apply?.description).toContain("preview_stale");
    } finally {
      await harness.close();
    }
  });
});

// T-6215: the MAC is taken over a key-sorted canonical form, so a store that does not keep object
// key order (Postgres jsonb, some document stores) does not turn a good record into
// preview_tampered, while any value change still does.
describe("the MAC ignores object key order (T-6215)", () => {
  const key = Buffer.from(KEY_A, "utf8");
  const expiresAt = new Date("2026-01-01T00:10:00Z");
  const seal: PreviewSeal = { key, previewId: "p-1", sessionId: "s-1", expiresAt };
  const base = {
    previewId: "p-1",
    sessionId: "s-1",
    marketplace: "ca",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt,
  } as const;

  const input = {
    orderNumber: "900000002",
    shipFrom: { city: "Testville", stateCode: "ON", zipCode: "M5V 2T6" },
    packages: [{ weightLb: 3.5, items: [{ sellerPartNumber: "SKU", quantity: 2 }] }],
  };
  const reordered = {
    packages: [{ items: [{ quantity: 2, sellerPartNumber: "SKU" }], weightLb: 3.5 }],
    shipFrom: { zipCode: "M5V 2T6", stateCode: "ON", city: "Testville" },
    orderNumber: "900000002",
  };

  const label = (hash: string, recordInput: unknown): PreviewRecord =>
    ({
      ...base,
      kind: "shippingLabelCreate",
      hash,
      input: recordInput,
      costCents: 1250,
    }) as unknown as PreviewRecord;

  it("a label record whose nested input keys were reordered still verifies", () => {
    const hash = hashLabelPreview(seal, "shippingLabelCreate", "ca", input, 1250);
    expect(previewHashMatches(key, label(hash, reordered))).toBe(true);
  });

  it("a changed value is still refused, at any depth", () => {
    const hash = hashLabelPreview(seal, "shippingLabelCreate", "ca", input, 1250);
    const deep = structuredClone(reordered);
    const item = deep.packages[0]?.items[0];
    if (item === undefined) throw new Error("fixture");
    item.quantity = 3;
    expect(previewHashMatches(key, label(hash, deep))).toBe(false);
  });

  it("array order still counts", () => {
    const twoItems = (order: string[]) => ({
      packages: [
        {
          items: order.map((sellerPartNumber) => ({ sellerPartNumber, quantity: 1 })),
        },
      ],
    });
    const hash = hashLabelPreview(seal, "shippingLabelCreate", "ca", twoItems(["A", "B"]), 1250);
    expect(previewHashMatches(key, label(hash, twoItems(["A", "B"])))).toBe(true);
    expect(previewHashMatches(key, label(hash, twoItems(["B", "A"])))).toBe(false);
  });

  it("volume-discount items with reordered tier keys still verify, a changed price does not", () => {
    const items = [
      {
        neweggItemNumber: "9SIAFAKE0000001",
        sellerPartNumber: "FAKE-SKU-1",
        tiers: [{ quantity: 5, sellingPrice: 95.5, freeShipping: true }],
      },
    ];
    const hash = hashItemsPreview(seal, "volumeDiscountUpdate", "ca", items as never);
    const record = (recordItems: unknown): PreviewRecord =>
      ({ ...base, kind: "volumeDiscountUpdate", hash, items: recordItems }) as PreviewRecord;
    const reorderedItems = [
      {
        tiers: [{ freeShipping: true, sellingPrice: 95.5, quantity: 5 }],
        sellerPartNumber: "FAKE-SKU-1",
        neweggItemNumber: "9SIAFAKE0000001",
      },
    ];
    expect(previewHashMatches(key, record(reorderedItems))).toBe(true);
    expect(
      previewHashMatches(
        key,
        record([
          { ...reorderedItems[0], tiers: [{ freeShipping: true, sellingPrice: 1, quantity: 5 }] },
        ]),
      ),
    ).toBe(false);
  });

  it("treats an absent property like JSON does, and keeps a null distinct", () => {
    const hash = hashServicePreview(seal, "courtesyRefundIssue", "ca", { amount: 5 }, 500);
    const record = (recordInput: unknown): PreviewRecord =>
      ({
        ...base,
        kind: "courtesyRefundIssue",
        hash,
        input: recordInput,
        refundCents: 500,
      }) as PreviewRecord;
    expect(previewHashMatches(key, record({ amount: 5, note: undefined }))).toBe(true);
    expect(previewHashMatches(key, record({ amount: 5, note: null }))).toBe(false);
  });
});
