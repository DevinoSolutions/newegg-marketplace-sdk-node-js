import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MockRoute, RecordedCall } from "@devino/newegg-marketplace-sdk/testing";
import {
  createNeweggMcpServer,
  InMemoryPreviewStore,
  loadMcpConfigFromEnv,
  type PreviewRecord,
} from "../src/index.js";
import {
  callTool,
  inventoryAndPriceRoute,
  makeEnv,
  makeMockClient,
  startHarness,
  type Harness,
} from "./helpers.js";

// T-5674 (I2): the stored hash is re-verified at apply for every kind.
// T-5675 (I3): previews are bound to the MCP session that created them.
// T-5670 (L6, store half): consumed/expired tombstones are swept and the store is bounded.

const writesEnv = () => makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true" });

const listingSubmitRoute: MockRoute = {
  method: "POST",
  pathPattern: "datafeedmgmt/feeds/submitfeed",
  reply: () => ({
    status: 200,
    body: {
      IsSuccess: true,
      ResponseBody: {
        ResponseList: [
          { RequestId: "REQ-9", RequestStatus: "SUBMITTED", RequestType: "ITEM_DATA" },
        ],
      },
    },
  }),
};

const priceRoutes: MockRoute[] = [
  {
    method: "PUT",
    pathPattern: /contentmgmt\/item\/inventoryandprice/,
    reply: () => ({ status: 200, body: { Result: "1", SellingPrice: "18.00" } }),
  },
  {
    method: "POST",
    pathPattern: /contentmgmt\/item\/price\?/,
    reply: () => ({
      status: 200,
      body: { Active: "1", SellerPartNumber: "SKU-1", SellingPrice: 20 },
    }),
  },
];

const LISTING_ITEM = {
  sellerPartNumber: "EB-TEST-1",
  manufacturer: "Corsair",
  upc: "840006676577",
  sellingPrice: 129.99,
  quantity: 1,
};

const VOLUME_ITEM = {
  neweggItemNumber: "9SIAFAKE0000001",
  sellerPartNumber: "FAKE-SKU-1",
  tiers: [
    { quantity: 5, sellingPrice: 95.5, freeShipping: true },
    { quantity: 10, sellingPrice: 90 },
  ],
};

/** First element of a stored list; the tamper cases fail loudly when it is missing. */
function first<T>(list: T[]): T {
  const head = list[0];
  if (head === undefined) throw new Error("expected a stored item to tamper with");
  return head;
}

/** The parts of a stored record the tamper cases reach into. */
interface Stored {
  normalizedUpdates: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown> & { tiers: Array<Record<string, unknown>> }>;
}

interface TamperCase {
  name: string;
  routes: MockRoute[];
  preview: [tool: string, args: Record<string, unknown>];
  apply: string;
  tamper: (stored: Stored) => void;
  /** True when the call is a write that must not have been sent. */
  isWrite: (call: RecordedCall) => boolean;
}

const writesOf = (harness: Harness, isWrite: TamperCase["isWrite"]) =>
  harness.calls.filter(isWrite);

const CASES: TamperCase[] = [
  {
    name: "inventory",
    routes: [inventoryAndPriceRoute()],
    preview: [
      "newegg_inventory_preview_update",
      { updates: [{ identifier: { type: "sellerPartNumber", value: "A" }, quantity: 5 }] },
    ],
    apply: "newegg_inventory_apply_update",
    tamper: (stored) => {
      first(stored.normalizedUpdates).quantity = 999;
    },
    isWrite: (call) => call.method === "PUT",
  },
  {
    name: "listing",
    routes: [listingSubmitRoute],
    preview: ["newegg_listing_preview_create", { items: [LISTING_ITEM] }],
    apply: "newegg_listing_apply_create",
    tamper: (stored) => {
      first(stored.items).sellingPrice = 1;
    },
    isWrite: (call) => call.method === "POST" && call.url.pathname.includes("submitfeed"),
  },
  {
    name: "pricing",
    routes: priceRoutes,
    preview: [
      "newegg_pricing_preview_update",
      { updates: [{ identifier: { type: "sellerPartNumber", value: "SKU-1" }, sellingPrice: 18 }] },
    ],
    apply: "newegg_pricing_apply_update",
    tamper: (stored) => {
      first(stored.normalizedUpdates).sellingPrice = 1;
    },
    isWrite: (call) => call.method === "PUT",
  },
  {
    name: "volume discount",
    routes: [listingSubmitRoute],
    preview: ["newegg_volume_discount_preview_update", { items: [VOLUME_ITEM] }],
    apply: "newegg_volume_discount_apply_update",
    tamper: (stored) => {
      first(first(stored.items).tiers).sellingPrice = 1;
    },
    isWrite: (call) => call.method === "POST" && call.url.pathname.includes("submitfeed"),
  },
];

describe("the preview hash is re-verified at apply (T-5674 / I2)", () => {
  for (const testCase of CASES) {
    it(`${testCase.name}: a record changed in the store is refused and nothing is sent`, async () => {
      const harness = await startHarness({ env: writesEnv(), routes: testCase.routes });
      try {
        const preview = await callTool(harness.mcp, testCase.preview[0], testCase.preview[1]);
        expect(preview.isError).toBe(false);
        const id = preview.json.previewId as string;
        const stored = await harness.previewStore.get(id);
        expect(stored).toBeDefined();
        testCase.tamper(stored as unknown as Stored);
        const applied = await callTool(harness.mcp, testCase.apply, { previewId: id });
        expect(applied.isError).toBe(true);
        expect(applied.json.errorCode).toBe("preview_tampered");
        expect(writesOf(harness, testCase.isWrite)).toHaveLength(0);
      } finally {
        await harness.close();
      }
    });

    it(`${testCase.name}: an untouched record still applies`, async () => {
      const harness = await startHarness({ env: writesEnv(), routes: testCase.routes });
      try {
        const preview = await callTool(harness.mcp, testCase.preview[0], testCase.preview[1]);
        const applied = await callTool(harness.mcp, testCase.apply, {
          previewId: preview.json.previewId as string,
        });
        expect(applied.isError).toBe(false);
        expect(writesOf(harness, testCase.isWrite).length).toBeGreaterThan(0);
      } finally {
        await harness.close();
      }
    });
  }
});

async function connectSession(store: InMemoryPreviewStore, sessionId: string | undefined) {
  const config = loadMcpConfigFromEnv(writesEnv());
  const mock = makeMockClient([inventoryAndPriceRoute()], config.marketplace);
  const instance = createNeweggMcpServer({
    config,
    client: mock.client,
    previewStore: store,
    sessionId,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "session-test", version: "0.0.0" });
  await Promise.all([mcp.connect(clientTransport), instance.server.connect(serverTransport)]);
  await mcp.listTools();
  return {
    mcp,
    calls: mock.calls,
    close: async () => {
      await mcp.close();
      await instance.close();
    },
  };
}

const PREVIEW_ARGS = {
  updates: [{ identifier: { type: "sellerPartNumber", value: "A" }, quantity: 7 }],
};

describe("previews are bound to the MCP session (T-5675 / I3)", () => {
  it("a preview created in session A cannot be applied from session B", async () => {
    const store = new InMemoryPreviewStore();
    const a = await connectSession(store, "session-a");
    const b = await connectSession(store, "session-b");
    try {
      const preview = await callTool(a.mcp, "newegg_inventory_preview_update", PREVIEW_ARGS);
      const id = preview.json.previewId as string;

      const foreign = await callTool(b.mcp, "newegg_inventory_apply_update", { previewId: id });
      expect(foreign.isError).toBe(true);
      expect(foreign.json.errorCode).toBe("preview_not_found");
      expect(b.calls.filter((call) => call.method === "PUT")).toHaveLength(0);

      // The foreign attempt must not burn the owner's preview.
      const own = await callTool(a.mcp, "newegg_inventory_apply_update", { previewId: id });
      expect(own.isError).toBe(false);
      expect(a.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("a record without a session id (stdio) is not applicable from an HTTP session", async () => {
    const store = new InMemoryPreviewStore();
    const stdio = await connectSession(store, undefined);
    const http = await connectSession(store, "session-http");
    try {
      const preview = await callTool(stdio.mcp, "newegg_inventory_preview_update", PREVIEW_ARGS);
      const id = preview.json.previewId as string;
      const foreign = await callTool(http.mcp, "newegg_inventory_apply_update", { previewId: id });
      expect(foreign.json.errorCode).toBe("preview_not_found");
      const own = await callTool(stdio.mcp, "newegg_inventory_apply_update", { previewId: id });
      expect(own.isError).toBe(false);
    } finally {
      await stdio.close();
      await http.close();
    }
  });

  it("stdio keeps working: preview and apply in the same unbound server", async () => {
    const harness = await startHarness({ env: writesEnv(), routes: [inventoryAndPriceRoute()] });
    try {
      const preview = await callTool(harness.mcp, "newegg_inventory_preview_update", PREVIEW_ARGS);
      const applied = await callTool(harness.mcp, "newegg_inventory_apply_update", {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("refuses a custom store that ignores the session scope (record checked after consume)", async () => {
    const inner = new InMemoryPreviewStore();
    const unscoped = {
      put: (record: PreviewRecord) => inner.put(record),
      get: (previewId: string) => inner.get(previewId),
      consume: (previewId: string) => inner.consume(previewId),
    };
    const config = loadMcpConfigFromEnv(writesEnv());
    const open = async (sessionId: string) => {
      const mock = makeMockClient([inventoryAndPriceRoute()], config.marketplace);
      const instance = createNeweggMcpServer({
        config,
        client: mock.client,
        previewStore: unscoped,
        sessionId,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcp = new Client({ name: "session-test", version: "0.0.0" });
      await Promise.all([mcp.connect(clientTransport), instance.server.connect(serverTransport)]);
      await mcp.listTools();
      return { mcp, calls: mock.calls, instance };
    };
    const a = await open("session-a");
    const b = await open("session-b");
    try {
      const preview = await callTool(a.mcp, "newegg_inventory_preview_update", PREVIEW_ARGS);
      const foreign = await callTool(b.mcp, "newegg_inventory_apply_update", {
        previewId: preview.json.previewId as string,
      });
      expect(foreign.json.errorCode).toBe("preview_not_found");
      expect(b.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    } finally {
      await a.mcp.close();
      await b.mcp.close();
    }
  });
});

describe("the in-memory preview store sweeps and bounds itself (T-5670 / L6)", () => {
  const record = (id: string, now: Date, ttlMs = 60_000): PreviewRecord =>
    ({
      previewId: id,
      kind: "listingCreate",
      hash: "h",
      marketplace: "ca",
      items: [],
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    }) as PreviewRecord;

  it("forgets a consumed preview once the tombstone retention has passed", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const store = new InMemoryPreviewStore(() => now);
    await store.put(record("p1", now));
    expect((await store.consume("p1")).status).toBe("ok");
    expect((await store.consume("p1")).status).toBe("already_used");

    now = new Date(now.getTime() + 60 * 60_000);
    await store.put(record("p2", now));
    expect((await store.consume("p1")).status).toBe("not_found");
  });

  it("forgets an expired, never-applied preview after the retention window", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const store = new InMemoryPreviewStore(() => now);
    await store.put(record("p1", now));
    now = new Date(now.getTime() + 2 * 60_000);
    expect((await store.consume("p1")).status).toBe("expired");

    now = new Date(now.getTime() + 60 * 60_000);
    await store.put(record("p2", now));
    expect((await store.consume("p1")).status).toBe("not_found");
  });

  it("caps the number of stored previews, dropping the oldest first", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const store = new InMemoryPreviewStore(() => now, { maxEntries: 3 });
    for (const id of ["p1", "p2", "p3", "p4", "p5"]) await store.put(record(id, now));
    expect((await store.consume("p1")).status).toBe("not_found");
    expect((await store.consume("p2")).status).toBe("not_found");
    expect((await store.consume("p5")).status).toBe("ok");
  });
});
