import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { loadMcpConfigFromEnv } from "../src/index.js";
import { callTool, makeEnv, SENTINELS, startHarness } from "./helpers.js";

const writesEnv = (overrides: Record<string, string | undefined> = {}) =>
  makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true", ...overrides });

const PREVIEW = "newegg_pricing_preview_update";
const APPLY = "newegg_pricing_apply_update";

/** Stateful CA price book: PUT inventoryandprice mutates, POST item/price reads (contracts §15/§16). */
function priceBook(initial: Record<string, { price: number; msrp?: number }>) {
  const state = new Map(Object.entries(initial));
  const routes: MockRoute[] = [
    {
      method: "PUT",
      pathPattern: /contentmgmt\/item\/inventoryandprice/,
      reply: (req) => {
        const body = req.bodyJson as { Value: string; SellingPrice: string };
        const row = state.get(body.Value);
        if (row) row.price = Number(body.SellingPrice);
        return { status: 200, body: { Result: "1", SellingPrice: body.SellingPrice } };
      },
    },
    {
      method: "POST",
      pathPattern: /contentmgmt\/item\/price\?/,
      reply: (req) => {
        const value = (req.bodyJson as { Value: string }).Value;
        const row = state.get(value);
        return row === undefined
          ? { status: 400, body: [{ Code: "CT026", Message: "Item does not exist" }] }
          : {
              status: 200,
              body: {
                Active: "1",
                SellerPartNumber: value,
                SellingPrice: row.price,
                ...(row.msrp === undefined ? {} : { MSRP: row.msrp }),
              },
            };
      },
    },
  ];
  return { state, routes };
}

const update = (value: string, sellingPrice: number) => ({
  identifier: { type: "sellerPartNumber", value },
  sellingPrice,
});

describe("price write tools - registration gate", () => {
  it("registers neither tool when writes are disabled", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      const { tools } = (await harness.mcp.listTools()) as { tools: Array<{ name: string }> };
      const names = tools.map((tool) => tool.name);
      expect(names).not.toContain(PREVIEW);
      expect(names).not.toContain(APPLY);
    } finally {
      await harness.close();
    }
  });

  it("registers both (preview read-only, apply mutating) when writes are enabled", async () => {
    const harness = await startHarness({ env: writesEnv(), routes: [] });
    try {
      const { tools } = (await harness.mcp.listTools()) as {
        tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
      };
      expect(tools.find((t) => t.name === PREVIEW)?.annotations?.readOnlyHint).toBe(true);
      expect(tools.find((t) => t.name === APPLY)?.annotations?.readOnlyHint).toBe(false);
    } finally {
      await harness.close();
    }
  });
});

describe("price write tools - preview then apply (ADR 0005)", () => {
  it("previews without writing, then applies exactly the stored prices and verifies them", async () => {
    const book = priceBook({ "SKU-1": { price: 20 } });
    const harness = await startHarness({ env: writesEnv(), routes: book.routes });
    try {
      const preview = await callTool(harness.mcp, PREVIEW, { updates: [update("SKU-1", 18)] });
      expect(preview.isError).toBe(false);
      expect(preview.json.mode).toBe("preview");
      expect(typeof preview.json.previewId).toBe("string");
      expect(preview.structuredContent).toEqual(preview.json);
      const items = preview.json.items as Array<Record<string, unknown>>;
      expect(items[0]).toMatchObject({
        status: "ok",
        currentSellingPrice: 20,
        newSellingPrice: 18,
        changePercent: -10,
      });
      // The preview wrote nothing.
      expect(harness.calls.some((c) => c.method === "PUT")).toBe(false);
      expect(book.state.get("SKU-1")?.price).toBe(20);

      const applied = await callTool(harness.mcp, APPLY, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(false);
      expect(applied.json).toMatchObject({
        mode: "apply",
        submittedItemCount: 1,
        appliedItemCount: 1,
        failedItemCount: 0,
        unresolvedItemCount: 0,
      });
      const applied0 = (applied.json.items as Array<Record<string, unknown>>)[0];
      expect(applied0).toMatchObject({ status: "verified", observedSellingPrice: 18 });
      const put = harness.calls.find((c) => c.method === "PUT");
      expect(put?.bodyJson).toEqual({ Type: "1", Value: "SKU-1", SellingPrice: "18.00" });
      expect(book.state.get("SKU-1")?.price).toBe(18);
    } finally {
      await harness.close();
    }
  });

  it("rejects a replayed previewId and writes only once", async () => {
    const book = priceBook({ "SKU-1": { price: 20 } });
    const harness = await startHarness({ env: writesEnv(), routes: book.routes });
    try {
      const preview = await callTool(harness.mcp, PREVIEW, { updates: [update("SKU-1", 18)] });
      const previewId = preview.json.previewId as string;
      expect((await callTool(harness.mcp, APPLY, { previewId })).isError).toBe(false);
      const second = await callTool(harness.mcp, APPLY, { previewId });
      expect(second.isError).toBe(true);
      expect(second.json.errorCode).toBe("preview_already_used");
      expect(harness.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("rejects an unknown previewId and an inventory preview id (kind mismatch) without writing", async () => {
    const book = priceBook({ "SKU-1": { price: 20 } });
    const harness = await startHarness({ env: writesEnv(), routes: book.routes });
    try {
      const unknown = await callTool(harness.mcp, APPLY, { previewId: "nope-nope-nope" });
      expect(unknown.isError).toBe(true);

      const inventoryPreview = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: [{ identifier: { type: "sellerPartNumber", value: "SKU-1" }, quantity: 3 }],
      });
      const mismatched = await callTool(harness.mcp, APPLY, {
        previewId: inventoryPreview.json.previewId as string,
      });
      expect(mismatched.isError).toBe(true);
      expect(harness.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("rejects an expired preview", async () => {
    const book = priceBook({ "SKU-1": { price: 20 } });
    let nowMs = Date.parse("2026-10-10T12:00:00Z");
    const harness = await startHarness({
      env: writesEnv({ NEWEGG_MCP_PREVIEW_TTL_SECONDS: "60" }),
      routes: book.routes,
      now: () => new Date(nowMs),
    });
    try {
      const preview = await callTool(harness.mcp, PREVIEW, { updates: [update("SKU-1", 18)] });
      nowMs += 61_000;
      const applied = await callTool(harness.mcp, APPLY, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(true);
      expect(applied.json.errorCode).toBe("preview_expired");
      expect(harness.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("apply accepts only a previewId - prices cannot be injected at apply time", async () => {
    const book = priceBook({ "SKU-1": { price: 20 } });
    const harness = await startHarness({ env: writesEnv(), routes: book.routes });
    try {
      const preview = await callTool(harness.mcp, PREVIEW, { updates: [update("SKU-1", 18)] });
      const injected = await callTool(harness.mcp, APPLY, {
        previewId: preview.json.previewId as string,
        updates: [update("SKU-1", 1)],
      }).catch((error: unknown) => error);
      // Strict schema: unknown keys are rejected (as a tool error or a protocol error).
      const rejected =
        injected instanceof Error || (injected as { isError?: boolean }).isError === true;
      expect(rejected).toBe(true);
      expect(harness.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("price write tools - server-side guards", () => {
  it("blocks a change above NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT and issues no previewId", async () => {
    const book = priceBook({ "SKU-1": { price: 100 } });
    const harness = await startHarness({
      env: writesEnv({ NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT: "10" }),
      routes: book.routes,
    });
    try {
      const preview = await callTool(harness.mcp, PREVIEW, { updates: [update("SKU-1", 50)] });
      expect(preview.isError).toBe(false);
      expect(preview.json.previewId).toBeUndefined();
      expect(preview.json.blockedItemCount).toBe(1);
      const item = (preview.json.items as Array<Record<string, unknown>>)[0];
      expect(item?.status).toBe("blocked");
      expect((item?.blockers as string[]).join(" ")).toContain(
        "NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT",
      );
    } finally {
      await harness.close();
    }
  });

  it("default limit is 50%: a 40% drop is allowed, a 60% drop is blocked", async () => {
    const book = priceBook({ A: { price: 100 }, B: { price: 100 } });
    const harness = await startHarness({ env: writesEnv(), routes: book.routes });
    try {
      const preview = await callTool(harness.mcp, PREVIEW, {
        updates: [update("A", 60), update("B", 40)],
      });
      const statuses = (preview.json.items as Array<{ status: string }>).map((i) => i.status);
      expect(statuses).toEqual(["ok", "blocked"]);
    } finally {
      await harness.close();
    }
  });

  it("stores only eligible updates: a blocked sibling can never be applied", async () => {
    const book = priceBook({ A: { price: 100 }, B: { price: 100 } });
    const harness = await startHarness({ env: writesEnv(), routes: book.routes });
    try {
      const preview = await callTool(harness.mcp, PREVIEW, {
        updates: [update("A", 90), update("B", 10)],
      });
      expect(preview.json.blockedItemCount).toBe(1);
      expect(preview.json.submittedItemCount).toBe(1);
      const applied = await callTool(harness.mcp, APPLY, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.json.submittedItemCount).toBe(1);
      const puts = harness.calls.filter((c) => c.method === "PUT");
      expect(puts).toHaveLength(1);
      expect((puts[0]?.bodyJson as { Value: string }).Value).toBe("A");
      expect(book.state.get("B")?.price).toBe(100);
    } finally {
      await harness.close();
    }
  });

  it("blocks an unknown item and a price above MSRP", async () => {
    const book = priceBook({ A: { price: 20, msrp: 25 } });
    const harness = await startHarness({ env: writesEnv(), routes: book.routes });
    try {
      const preview = await callTool(harness.mcp, PREVIEW, {
        updates: [update("A", 26), update("NOPE", 5)],
      });
      const items = preview.json.items as Array<{ status: string; blockers?: string[] }>;
      expect(items.map((i) => i.status)).toEqual(["blocked", "blocked"]);
      expect(items[0]?.blockers?.join(" ")).toContain("MSRP");
      expect(preview.json.previewId).toBeUndefined();
      expect(harness.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("rejects invalid input at the schema (zero, 3 decimals handled by SDK, extra keys)", async () => {
    const harness = await startHarness({ env: writesEnv(), routes: [] });
    try {
      const zero = await callTool(harness.mcp, PREVIEW, { updates: [update("A", 0)] }).catch(
        (error: unknown) => error,
      );
      expect(zero instanceof Error || (zero as { isError?: boolean }).isError === true).toBe(true);
      const extra = await callTool(harness.mcp, PREVIEW, {
        updates: [{ ...update("A", 5), map: 4 }],
      }).catch((error: unknown) => error);
      expect(extra instanceof Error || (extra as { isError?: boolean }).isError === true).toBe(
        true,
      );
      const threeDecimals = await callTool(harness.mcp, PREVIEW, {
        updates: [update("A", 1.005)],
      });
      expect(threeDecimals.isError).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("never leaks credentials in output", async () => {
    const book = priceBook({ "SKU-1": { price: 20 } });
    const harness = await startHarness({ env: writesEnv(), routes: book.routes });
    try {
      const preview = await callTool(harness.mcp, PREVIEW, { updates: [update("SKU-1", 18)] });
      const applied = await callTool(harness.mcp, APPLY, {
        previewId: preview.json.previewId as string,
      });
      const text = JSON.stringify([preview.json, applied.json]);
      for (const secret of Object.values(SENTINELS)) expect(text).not.toContain(secret);
    } finally {
      await harness.close();
    }
  });
});

describe("NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT config", () => {
  it.each(["0", "-5", "abc", "10001"])("rejects %s", (value) => {
    expect(() =>
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT: value })),
    ).toThrow(/NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT/);
  });

  it("parses a valid value and defaults to 50", () => {
    expect(
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT: "12.5" })).limits
        .maxPriceChangePercent,
    ).toBe(12.5);
    expect(loadMcpConfigFromEnv(makeEnv()).limits.maxPriceChangePercent).toBe(50);
  });
});
