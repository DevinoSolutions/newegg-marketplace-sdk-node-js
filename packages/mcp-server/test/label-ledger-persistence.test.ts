import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNeweggClient } from "@devino/newegg-marketplace-sdk";
import { createMockFetch, type MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { InMemoryPreviewStore, loadMcpConfigFromEnv } from "../src/index.js";
import { OperationStoreFileError } from "../src/server/file-operation-store.js";
import { clearLabelCreateGuard, operationStoreFor } from "../src/server/operation-store.js";
import {
  callTool,
  makeEnv,
  SENTINELS,
  startHarness,
  type FakeEnv,
  type Harness,
} from "./helpers.js";

/**
 * T-6280: the label-create duplicate ledger (T-6212) survives a restart when
 * NEWEGG_MCP_OPERATION_STORE_FILE names a file. A "restart" here is a second server stack (new
 * preview store, new operation store, new client) over the same file. Nothing touches a real account.
 */
const ORDER_NUMBER = "900000002";
const SKU = "SKU-PLACEHOLDER";
const TRACKING = "1ZTEST0000000000";
const HOUR = 3_600_000;

const TOOLS = {
  previewCreate: "newegg_shipping_label_preview_create",
  applyCreate: "newegg_shipping_label_apply_create",
} as const;

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "newegg-ledger-persist-"));
  file = join(dir, "operations.json");
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function orderBody(): unknown {
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

const TIMEOUT = { status: 504, body: "gateway timeout" };
const OK = { status: 200, body: successBody };

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

interface Stack {
  harness: Harness;
  posts: () => number;
}

/**
 * One server process: its own preview store, operation store (wired exactly as the server wires it
 * from the config) and client, over the shared file.
 */
async function startStack(
  creates: Array<{ status: number; body: unknown }>,
  envOverrides: FakeEnv = {},
): Promise<Stack> {
  const env = makeEnv({
    NEWEGG_MCP_ALLOW_WRITES: "true",
    NEWEGG_MCP_MAX_LABEL_AMOUNT: "unlimited",
    NEWEGG_MCP_OPERATION_STORE_FILE: file,
    ...envOverrides,
  });
  const config = loadMcpConfigFromEnv(env);
  const previewStore = new InMemoryPreviewStore();
  let createIndex = 0;
  const routes: MockRoute[] = [
    {
      method: "PUT",
      pathPattern: /ordermgmt\/order\/orderinfo\?/,
      reply: () => ({ status: 200, body: orderBody() }),
    },
    {
      method: "POST",
      pathPattern: /shippingservice\/shippinglabel\/createshippinglabel/,
      reply: () => creates[Math.min(createIndex++, creates.length - 1)] ?? OK,
    },
  ];
  const { fetch, calls } = createMockFetch(routes);
  const client = createNeweggClient({
    sellerId: SENTINELS.sellerId,
    apiKey: SENTINELS.apiKey,
    secretKey: SENTINELS.secretKey,
    marketplace: config.marketplace,
    fetch,
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    operationStore: operationStoreFor(previewStore, config),
    labelCreateGuardWindowMs: config.limits.labelCreateGuardHours * HOUR,
  });
  const harness = await startHarness({ env, client, previewStore });
  return { harness, posts: () => calls.filter((call) => call.method === "POST").length };
}

describe("label create ledger survives a restart", () => {
  it("still blocks the duplicate after an indeterminate create and a restart", async () => {
    const first = await startStack([TIMEOUT]);
    try {
      const preview = await callTool(first.harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(preview.json.eligible).toBe(true);
      const applied = await callTool(first.harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.json.errorCode).toBe("order_write_indeterminate");
      expect(first.posts()).toBe(1);
    } finally {
      await first.harness.close();
    }

    const second = await startStack([OK]);
    try {
      const blocked = await callTool(second.harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(blocked.json.eligible).toBe(false);
      expect(blocked.json.previewId).toBeUndefined();
      expect((blocked.json.priorAttempt as { state: string }).state).toBe("submitting");
      expect((blocked.json.blockers as string[]).join(" ")).toContain("Seller Portal");
      expect(second.posts()).toBe(0);
    } finally {
      await second.harness.close();
    }
  });

  it("remembers a confirmed purchase too (state submitted) across a restart", async () => {
    const first = await startStack([OK]);
    try {
      const preview = await callTool(first.harness.mcp, TOOLS.previewCreate, labelArgs);
      const applied = await callTool(first.harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(false);
    } finally {
      await first.harness.close();
    }
    const second = await startStack([OK]);
    try {
      const blocked = await callTool(second.harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(blocked.json.eligible).toBe(false);
      expect((blocked.json.priorAttempt as { state: string }).state).toBe("submitted");
    } finally {
      await second.harness.close();
    }
  });

  it("without the file the ledger is in memory and a restart forgets it (the default)", async () => {
    const first = await startStack([TIMEOUT], { NEWEGG_MCP_OPERATION_STORE_FILE: undefined });
    try {
      const preview = await callTool(first.harness.mcp, TOOLS.previewCreate, labelArgs);
      await callTool(first.harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
    } finally {
      await first.harness.close();
    }
    const second = await startStack([OK], { NEWEGG_MCP_OPERATION_STORE_FILE: undefined });
    try {
      const preview = await callTool(second.harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(preview.json.eligible).toBe(true);
    } finally {
      await second.harness.close();
    }
  });

  it("keeps only the label ledger in the file, never feed submission records", async () => {
    const config = loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_OPERATION_STORE_FILE: file }));
    const store = operationStoreFor(new InMemoryPreviewStore(), config);
    const record = {
      state: "submitted" as const,
      payloadHash: "h",
      requestIds: ["r"],
      updatedAt: new Date().toISOString(),
    };
    await store.put("ca:SELLER:feed:abc", record);
    await store.put("label-create:ca:5", record);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { operations: Record<string, unknown> };
    expect(Object.keys(onDisk.operations)).toEqual(["label-create:ca:5"]);
    // The feed record still dedups inside this process.
    expect(await store.get("ca:SELLER:feed:abc")).toEqual(record);
  });
});

describe("two server processes sharing one file", () => {
  it("send exactly one label request when both apply the same order at once", async () => {
    const a = await startStack([OK]);
    const b = await startStack([OK]);
    try {
      const previewA = await callTool(a.harness.mcp, TOOLS.previewCreate, labelArgs);
      const previewB = await callTool(b.harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(previewA.json.eligible).toBe(true);
      expect(previewB.json.eligible).toBe(true);
      const results = await Promise.all([
        callTool(a.harness.mcp, TOOLS.applyCreate, { previewId: previewA.json.previewId as string }),
        callTool(b.harness.mcp, TOOLS.applyCreate, { previewId: previewB.json.previewId as string }),
      ]);
      expect(a.posts() + b.posts()).toBe(1);
      expect(results.filter((result) => !result.isError)).toHaveLength(1);
      expect(
        results.filter((result) => result.json.errorCode === "label_create_already_attempted"),
      ).toHaveLength(1);
    } finally {
      await a.harness.close();
      await b.harness.close();
    }
  });

  it("a second process sees the first one's attempt without restarting", async () => {
    const a = await startStack([TIMEOUT]);
    const b = await startStack([OK]);
    try {
      const previewA = await callTool(a.harness.mcp, TOOLS.previewCreate, labelArgs);
      await callTool(a.harness.mcp, TOOLS.applyCreate, { previewId: previewA.json.previewId as string });
      const blocked = await callTool(b.harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(blocked.json.eligible).toBe(false);
      expect(b.posts()).toBe(0);
    } finally {
      await a.harness.close();
      await b.harness.close();
    }
  });
});

describe("a bad store file fails closed", () => {
  it("refuses to build the store from a corrupt file (nothing starts empty)", () => {
    writeFileSync(file, "{ definitely not json");
    const config = loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_OPERATION_STORE_FILE: file }));
    expect(() => operationStoreFor(new InMemoryPreviewStore(), config)).toThrow(
      OperationStoreFileError,
    );
  });

  it("sends nothing and reports a store error when the file turns corrupt while running", async () => {
    const stack = await startStack([OK]);
    try {
      const preview = await callTool(stack.harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(preview.json.eligible).toBe(true);
      writeFileSync(file, "{ truncated");
      const applied = await callTool(stack.harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(true);
      expect(stack.posts()).toBe(0);
      const again = await callTool(stack.harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(again.isError).toBe(true);
      expect(again.json.previewId).toBeUndefined();
      expect(readFileSync(file, "utf8")).toBe("{ truncated");
    } finally {
      await stack.harness.close();
    }
  });
});

describe("operator clear", () => {
  it("frees the order for a new server after the operator clears it, and nothing else", async () => {
    const first = await startStack([TIMEOUT]);
    try {
      const preview = await callTool(first.harness.mcp, TOOLS.previewCreate, labelArgs);
      await callTool(first.harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
    } finally {
      await first.harness.close();
    }

    expect(await clearLabelCreateGuard(file, "ca", ORDER_NUMBER)).toBe(true);
    expect(await clearLabelCreateGuard(file, "ca", ORDER_NUMBER)).toBe(false);

    const second = await startStack([OK]);
    try {
      const preview = await callTool(second.harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(preview.json.eligible).toBe(true);
    } finally {
      await second.harness.close();
    }
  });

  it("only clears the named marketplace and order", async () => {
    const first = await startStack([TIMEOUT]);
    try {
      const preview = await callTool(first.harness.mcp, TOOLS.previewCreate, labelArgs);
      await callTool(first.harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
    } finally {
      await first.harness.close();
    }
    expect(await clearLabelCreateGuard(file, "us", ORDER_NUMBER)).toBe(false);
    expect(await clearLabelCreateGuard(file, "ca", "900000003")).toBe(false);
    const second = await startStack([OK]);
    try {
      const blocked = await callTool(second.harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(blocked.json.eligible).toBe(false);
    } finally {
      await second.harness.close();
    }
  });

  it("a running server keeps blocking until it restarts (its in-process claim is not erased)", async () => {
    const running = await startStack([TIMEOUT]);
    try {
      const preview = await callTool(running.harness.mcp, TOOLS.previewCreate, labelArgs);
      await callTool(running.harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
      expect(await clearLabelCreateGuard(file, "ca", ORDER_NUMBER)).toBe(true);
      const stillBlocked = await callTool(running.harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(stillBlocked.json.eligible).toBe(false);
    } finally {
      await running.harness.close();
    }
  });

  it("validates its arguments before touching the file", async () => {
    await expect(clearLabelCreateGuard(file, "ca", "not-a-number")).rejects.toThrow(/order number/i);
    await expect(clearLabelCreateGuard(file, "mars", ORDER_NUMBER)).rejects.toThrow(/marketplace/i);
  });

  it("is not reachable through any MCP tool", async () => {
    const stack = await startStack([OK]);
    try {
      const { tools } = await stack.harness.mcp.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain(TOOLS.applyCreate);
      for (const name of names) {
        expect(name).not.toMatch(/clear|reset|release|unblock|acknowledg|operation_store|guard/i);
      }
      for (const tool of tools) {
        const schema = JSON.stringify(tool.inputSchema);
        expect(schema).not.toMatch(/acknowledg|clearGuard|operationStore|attemptId/i);
        expect(`${tool.title ?? ""} ${tool.description ?? ""}`).not.toMatch(/acknowledgePriorAttemptId/);
      }
      // Guessing the old SDK argument is rejected by the strict input schema.
      const guessed = await callTool(stack.harness.mcp, TOOLS.previewCreate, {
        ...labelArgs,
        acknowledgePriorAttemptId: "anything",
      });
      expect(guessed.isError).toBe(true);
    } finally {
      await stack.harness.close();
    }
  });

  it("the blocked-create guidance names the shell command but no tool", async () => {
    const first = await startStack([TIMEOUT]);
    try {
      const preview = await callTool(first.harness.mcp, TOOLS.previewCreate, labelArgs);
      await callTool(first.harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
      const blocked = await callTool(first.harness.mcp, TOOLS.previewCreate, labelArgs);
      const text = (blocked.json.blockers as string[]).join(" ");
      expect(text).toContain("--clear-label-guard");
      expect(text).toContain("restart");
      expect(text).not.toMatch(/acknowledg/i);
    } finally {
      await first.harness.close();
    }
  });
});

describe("guard window (NEWEGG_MCP_LABEL_CREATE_GUARD_HOURS)", () => {
  const hours = (value: string | undefined) =>
    loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_LABEL_CREATE_GUARD_HOURS: value })).limits
      .labelCreateGuardHours;

  it("defaults to 24 hours and accepts 1 to 720", () => {
    expect(hours(undefined)).toBe(24);
    expect(hours("")).toBe(24);
    expect(hours("1")).toBe(1);
    expect(hours("72")).toBe(72);
    expect(hours("720")).toBe(720);
  });

  it.each(["0", "721", "-1", "1.5", "24h", "0x10", "1e2", " abc ", "99999"])(
    "rejects %j naming the variable",
    (value) => {
      expect(() => hours(value)).toThrow(/NEWEGG_MCP_LABEL_CREATE_GUARD_HOURS/);
    },
  );

  it("is the window the server enforces", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-22T00:00:00.000Z");
    vi.setSystemTime(t0);
    const first = await startStack([TIMEOUT], { NEWEGG_MCP_LABEL_CREATE_GUARD_HOURS: "2" });
    try {
      const preview = await callTool(first.harness.mcp, TOOLS.previewCreate, labelArgs);
      await callTool(first.harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
    } finally {
      await first.harness.close();
    }
    vi.setSystemTime(new Date(t0.getTime() + HOUR));
    const within = await startStack([OK], { NEWEGG_MCP_LABEL_CREATE_GUARD_HOURS: "2" });
    try {
      const blocked = await callTool(within.harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(blocked.json.eligible).toBe(false);
    } finally {
      await within.harness.close();
    }
    vi.setSystemTime(new Date(t0.getTime() + 2 * HOUR + 1000));
    const after = await startStack([OK], { NEWEGG_MCP_LABEL_CREATE_GUARD_HOURS: "2" });
    try {
      const preview = await callTool(after.harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(preview.json.eligible).toBe(true);
    } finally {
      await after.harness.close();
    }
  });
});

describe("NEWEGG_MCP_OPERATION_STORE_FILE parsing", () => {
  it("is absent by default", () => {
    expect(loadMcpConfigFromEnv(makeEnv()).operationStoreFile).toBeUndefined();
    expect(
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_OPERATION_STORE_FILE: "  " })).operationStoreFile,
    ).toBeUndefined();
  });

  it("is resolved to an absolute path", () => {
    const config = loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_OPERATION_STORE_FILE: file }));
    expect(config.operationStoreFile).toBe(file);
    const relative = loadMcpConfigFromEnv(
      makeEnv({ NEWEGG_MCP_OPERATION_STORE_FILE: "ledger.json" }),
    );
    expect(relative.operationStoreFile).toMatch(/ledger\.json$/);
    expect(relative.operationStoreFile).not.toBe("ledger.json");
  });

  it("rejects a value with a NUL byte", () => {
    expect(() =>
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_OPERATION_STORE_FILE: "a\0b" })),
    ).toThrow(/NEWEGG_MCP_OPERATION_STORE_FILE/);
  });
});
