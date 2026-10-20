import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { loadMcpConfigFromEnv, type ShippingLabelPreviewRecord } from "../src/index.js";
import { callTool, makeEnv, startHarness, type Harness } from "./helpers.js";

/**
 * Mocked end-to-end coverage (real MCP client over an in-memory transport) of the Shipping Label
 * tools (contracts §23): the estimate read tool, the registration gate of the four write tools,
 * preview -> apply (ADR 0005), previewId misuse, the indeterminate-outcome contract and PII
 * hygiene. A label purchase spends money, so nothing here ever touches a real account.
 */
const ORDER_NUMBER = "900000002";
const SKU = "SKU-PLACEHOLDER";
const CUSTOMER_SENTINEL = "CUSTOMER-NAME-SENTINEL";
const ADDRESS_SENTINEL = "SHIPTO-ADDRESS-SENTINEL";
const TRACKING = "1ZTEST0000000000";
const LABEL_URL = "https://labels.newegg.com/test/label.pdf";
const PACKING_URL = "https://labels.newegg.com/test/packing.pdf";

const writesEnv = (overrides: Record<string, string | undefined> = {}) =>
  makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true", ...overrides });

const TOOLS = {
  estimate: "newegg_shipping_label_estimate",
  previewCreate: "newegg_shipping_label_preview_create",
  applyCreate: "newegg_shipping_label_apply_create",
  previewReprint: "newegg_shipping_label_preview_reprint",
  applyReprint: "newegg_shipping_label_apply_reprint",
} as const;
const WRITE_TOOLS = [
  TOOLS.previewCreate,
  TOOLS.applyCreate,
  TOOLS.previewReprint,
  TOOLS.applyReprint,
];

const CREATE = /shippingservice\/shippinglabel\/createshippinglabel/;
const ESTIMATE = /shippingservice\/shippinglabel\/estimateshippinglabel/;
const REPRINT = /shippingservice\/shippinglabel\/reprintshippinglabel/;

function orderBody(shipped = false): unknown {
  return {
    IsSuccess: true,
    ResponseBody: {
      PageInfo: { TotalCount: 1, TotalPageCount: 1, PageIndex: 1, PageSize: 100 },
      OrderInfoList: [
        {
          OrderNumber: ORDER_NUMBER,
          OrderStatus: shipped ? 2 : 0,
          SalesChannel: 0,
          FulfillmentOption: 0,
          CurrencyCode: "CAD",
          CustomerName: CUSTOMER_SENTINEL,
          ShipToAddress1: ADDRESS_SENTINEL,
          ShipToCountryCode: "CA",
          OrderTotalAmount: "110.00",
          ItemInfoList: [
            {
              SellerPartNumber: SKU,
              OrderedQty: 2,
              ShippedQty: shipped ? 2 : 0,
              UnitPrice: "50.00",
              Status: shipped ? 2 : 0,
            },
          ],
        },
      ],
    },
  };
}

const orderRoute = (shipped = false): MockRoute => ({
  method: "PUT",
  pathPattern: /ordermgmt\/order\/orderinfo\?/,
  reply: () => ({ status: 200, body: orderBody(shipped) }),
});

const labelPackage = (overrides: Record<string, unknown> = {}) => ({
  TrackingNumber: TRACKING,
  ProcessResult: "Success",
  LabelUrl: LABEL_URL,
  PackingListUrl: PACKING_URL,
  Rate: { ShippingAmount: "12.34", SignatureOptions: "0", Total: "12.34" },
  ItemList: { Item: { SellerPartNumber: SKU, Quantity: "2" } },
  ...overrides,
});

const createBody = (pkg: Record<string, unknown> = labelPackage()) => ({
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

const reprintBody = {
  NeweggAPIRequest: {
    ResponseBody: {
      Shipment: {
        OrderNumber: ORDER_NUMBER,
        OrderStatus: "Shipped",
        PackageList: { Package: labelPackage() },
      },
    },
  },
};

const postRoute = (pattern: RegExp, status: number, body: unknown): MockRoute => ({
  method: "POST",
  pathPattern: pattern,
  reply: () => ({ status, body }),
});

function harnessFor(writes: MockRoute[], env = writesEnv(), now?: () => Date, shipped = false) {
  return startHarness({ env, routes: [orderRoute(shipped), ...writes], now });
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

describe("shipping label tools - registration gate", () => {
  it("registers only the estimate read tool when writes are disabled", async () => {
    for (const env of [
      makeEnv(),
      makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "false" }),
      makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "TRUE" }),
    ]) {
      const harness = await startHarness({ env, routes: [] });
      try {
        const { tools } = (await harness.mcp.listTools()) as { tools: Array<{ name: string }> };
        const names = tools.map((tool) => tool.name);
        expect(names).toContain(TOOLS.estimate);
        for (const name of WRITE_TOOLS) expect(names, name).not.toContain(name);
        const direct = await callTool(harness.mcp, TOOLS.applyCreate, { previewId: "x" });
        expect(direct.isError).toBe(true);
        expect(harness.calls).toHaveLength(0);
      } finally {
        await harness.close();
      }
    }
  });

  it("registers all four with writes enabled: previews read-only, applies destructive and non-idempotent", async () => {
    const harness = await startHarness({ env: writesEnv(), routes: [] });
    try {
      const { tools } = (await harness.mcp.listTools()) as {
        tools: Array<{
          name: string;
          description?: string;
          annotations?: {
            readOnlyHint?: boolean;
            destructiveHint?: boolean;
            idempotentHint?: boolean;
          };
        }>;
      };
      const estimate = tools.find((tool) => tool.name === TOOLS.estimate);
      expect(estimate?.annotations?.readOnlyHint).toBe(true);
      for (const name of WRITE_TOOLS) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool, name).toBeDefined();
        const isApply = name.includes("_apply_");
        expect(tool!.annotations?.readOnlyHint, name).toBe(!isApply);
        if (isApply) {
          expect(tool!.annotations?.destructiveHint, name).toBe(true);
          expect(tool!.annotations?.idempotentHint, name).toBe(false);
          expect(tool!.description, name).toContain("writes enabled");
        }
      }
      const create = tools.find((tool) => tool.name === TOOLS.applyCreate);
      expect(create?.description).toMatch(/charges the seller's Newegg account/);
      expect(create?.description).toContain("WARNING");
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_shipping_label_estimate", () => {
  it("quotes with a single estimate POST and works with writes disabled", async () => {
    const harness = await startHarness({
      env: makeEnv(),
      routes: [
        postRoute(ESTIMATE, 200, {
          NeweggAPIResponse: {
            IsSuccess: "true",
            ResponseBody: {
              Shipment: {
                OrderNumber: ORDER_NUMBER,
                PackageList: {
                  Package: {
                    ProcessResult: "Success",
                    EstimatedRate: { EstimatedShippingAmount: "9.99", EstimatedTotal: "9.99" },
                  },
                },
              },
            },
          },
        }),
        postRoute(CREATE, 200, createBody()),
      ],
    });
    try {
      const res = await callTool(harness.mcp, TOOLS.estimate, labelArgs);
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        orderNumber: ORDER_NUMBER,
        currency: "CAD",
        estimatedTotal: 9.99,
      });
      const sent = posts(harness);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url.pathname).toBe(
        "/marketplace/can/shippingservice/shippinglabel/estimateshippinglabel",
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects a package over the UPS limit at the schema, before any call", async () => {
    const harness = await startHarness({ env: makeEnv(), routes: [] });
    try {
      const res = await callTool(harness.mcp, TOOLS.estimate, {
        ...labelArgs,
        packages: [{ ...labelArgs.packages[0], weightLb: 200 }],
      });
      expect(res.isError).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("label purchase: preview -> apply", () => {
  it("previews with zero POSTs, then applies exactly the stored request once", async () => {
    const harness = await harnessFor([postRoute(CREATE, 200, createBody())]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(preview.isError).toBe(false);
      expect(preview.structuredContent).toEqual(preview.json);
      expect(preview.json).toMatchObject({
        mode: "preview",
        operation: "shippingLabels.create",
        eligible: true,
        currency: "CAD",
        blockers: [],
      });
      expect(typeof preview.json.previewId).toBe("string");
      expect(posts(harness)).toHaveLength(0);

      const applied = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(false);
      expect(applied.json).toMatchObject({
        mode: "apply",
        operation: "shippingLabels.create",
        orderNumber: ORDER_NUMBER,
        succeededCount: 1,
        failedCount: 0,
        totalCharged: 12.34,
      });
      const pkg = (applied.json.packages as Array<Record<string, unknown>>)[0];
      expect(pkg).toMatchObject({
        succeeded: true,
        trackingNumber: TRACKING,
        labelUrl: LABEL_URL,
        packingListUrl: PACKING_URL,
        urlWithheld: false,
      });
      const sent = posts(harness);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url.pathname).toBe(
        "/marketplace/can/shippingservice/shippinglabel/createshippinglabel",
      );
      const body = sent[0]!.bodyJson as {
        NeweggAPIRequest: { OperationType: string; RequestBody: { Shipment: unknown } };
      };
      expect(body.NeweggAPIRequest.OperationType).toBe("CreateShippingLabel");
      // Customer data of the order never reaches a tool result.
      for (const text of [preview.text, applied.text]) {
        expect(text).not.toContain(CUSTOMER_SENTINEL);
        expect(text).not.toContain(ADDRESS_SENTINEL);
      }
    } finally {
      await harness.close();
    }
  });

  it("withholds a label link that is not an https newegg.com URL", async () => {
    const harness = await harnessFor([
      postRoute(
        CREATE,
        200,
        createBody(labelPackage({ LabelUrl: "https://evil.example/label.pdf" })),
      ),
    ]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const applied = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
      const pkg = (applied.json.packages as Array<Record<string, unknown>>)[0];
      expect(pkg?.labelUrl).toBeUndefined();
      expect(pkg?.urlWithheld).toBe(true);
      expect(applied.text).not.toContain("evil.example");
    } finally {
      await harness.close();
    }
  });

  it.each([
    "http://labels.newegg.com/label.pdf",
    "https://newegg.com.evil.example/label.pdf",
    "https://evilnewegg.com/label.pdf",
    "https://labels.newegg.com@evil.example/label.pdf",
    "https://evil.example@labels.newegg.com/label.pdf",
    "https://labels.newegg.com./label.pdf",
    "https://.newegg.com/label.pdf",
    "label.pdf",
  ])("withholds the lookalike or non-https label link %s", async (link) => {
    const harness = await harnessFor([
      postRoute(CREATE, 200, createBody(labelPackage({ LabelUrl: link }))),
    ]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const applied = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
      const pkg = (applied.json.packages as Array<Record<string, unknown>>)[0];
      expect(pkg?.labelUrl).toBeUndefined();
      expect(pkg?.urlWithheld).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("returns a plain https newegg.com subdomain link in any case", async () => {
    const harness = await harnessFor([
      postRoute(
        CREATE,
        200,
        createBody(labelPackage({ LabelUrl: "HTTPS://Labels.Newegg.com/label.pdf?t=1" })),
      ),
    ]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const applied = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
      const pkg = (applied.json.packages as Array<Record<string, unknown>>)[0];
      expect(pkg?.labelUrl).toBe("https://labels.newegg.com/label.pdf?t=1");
      expect(pkg?.urlWithheld).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("issues no previewId when the SDK finds a blocker (order already shipped)", async () => {
    const harness = await harnessFor(
      [postRoute(CREATE, 200, createBody())],
      writesEnv(),
      undefined,
      true,
    );
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      expect(preview.json.eligible).toBe(false);
      expect(preview.json.previewId).toBeUndefined();
      expect((preview.json.blockers as string[]).join("\n")).toContain("SL003");
      const applied = await callTool(harness.mcp, TOOLS.applyCreate, { previewId: "none" });
      expect(applied.json.errorCode).toBe("preview_not_found");
      expect(posts(harness)).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("rejects invalid input at the schema (strict keys, UPS limits) before any call", async () => {
    const harness = await harnessFor([]);
    try {
      for (const bad of [
        { ...labelArgs, extra: true },
        { ...labelArgs, previewId: "x" },
        { ...labelArgs, packages: [] },
        { ...labelArgs, packages: [{ ...labelArgs.packages[0], lengthIn: 120 }] },
        { ...labelArgs, packages: [{ ...labelArgs.packages[0], items: [] }] },
      ]) {
        const res = await callTool(harness.mcp, TOOLS.previewCreate, bad);
        expect(res.isError).toBe(true);
      }
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("stores records tagged with their kind", async () => {
    const harness = await harnessFor([]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const record = (await harness.previewStore.get(preview.json.previewId as string)) as
        ShippingLabelPreviewRecord | undefined;
      expect(record?.kind).toBe("shippingLabelCreate");
      expect(record?.marketplace).toBe("ca");
    } finally {
      await harness.close();
    }
  });
});

describe("previewId misuse is rejected", () => {
  it("rejects an unknown id, a wrong-tool id, a replay and an expired id, sending nothing extra", async () => {
    let nowMs = Date.parse("2026-10-20T00:00:00Z");
    const harness = await harnessFor(
      [postRoute(CREATE, 200, createBody()), postRoute(REPRINT, 200, reprintBody)],
      writesEnv(),
      () => new Date(nowMs),
    );
    try {
      const unknown = await callTool(harness.mcp, TOOLS.applyCreate, { previewId: "nope" });
      expect(unknown.json.errorCode).toBe("preview_not_found");

      // A previewId minted for a purchase cannot be applied by the reprint tool, and the
      // mismatch consumes it.
      const createPreview = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const wrong = await callTool(harness.mcp, TOOLS.applyReprint, {
        previewId: createPreview.json.previewId as string,
      });
      expect(wrong.json.errorCode).toBe("preview_kind_mismatch");
      const afterWrong = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: createPreview.json.previewId as string,
      });
      expect(afterWrong.json.errorCode).toBe("preview_already_used");

      const preview = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const id = preview.json.previewId as string;
      const first = await callTool(harness.mcp, TOOLS.applyCreate, { previewId: id });
      expect(first.isError).toBe(false);
      const replay = await callTool(harness.mcp, TOOLS.applyCreate, { previewId: id });
      expect(replay.json.errorCode).toBe("preview_already_used");
      expect(posts(harness)).toHaveLength(1);

      const stale = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      nowMs += 601_000;
      const expired = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: stale.json.previewId as string,
      });
      expect(expired.json.errorCode).toBe("preview_expired");
      expect(posts(harness)).toHaveLength(1);

      // The apply tools take only a previewId.
      const extra = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: id,
        serviceCode: 114,
      });
      expect(extra.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("refuses a stored preview whose content no longer matches its hash", async () => {
    const harness = await harnessFor([postRoute(CREATE, 200, createBody())]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const id = preview.json.previewId as string;
      const stored = (await harness.previewStore.get(id)) as unknown as {
        input: { serviceCode: number };
      };
      // Simulates a store that was tampered with between preview and apply.
      stored.input.serviceCode = 114;
      const applied = await callTool(harness.mcp, TOOLS.applyCreate, { previewId: id });
      expect(applied.isError).toBe(true);
      expect(applied.json.errorCode).toBe("preview_tampered");
      expect(posts(harness)).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("indeterminate outcomes", () => {
  it("reports an unknown outcome with guidance, never retries, and burns the previewId", async () => {
    const harness = await harnessFor([postRoute(CREATE, 503, "unavailable")]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const id = preview.json.previewId as string;
      const applied = await callTool(harness.mcp, TOOLS.applyCreate, { previewId: id });
      expect(applied.isError).toBe(true);
      expect(applied.json.errorCode).toBe("order_write_indeterminate");
      expect(applied.json.retryable).toBe(false);
      expect(applied.json.message).toContain("Do NOT retry");
      expect(applied.json.message).toContain("reprint");
      expect(posts(harness)).toHaveLength(1);
      const again = await callTool(harness.mcp, TOOLS.applyCreate, { previewId: id });
      expect(again.json.errorCode).toBe("preview_already_used");
      expect(posts(harness)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("passes a definitive Newegg error through with the consumed note", async () => {
    const harness = await harnessFor([
      postRoute(CREATE, 400, [{ Code: "SL003", Message: "Order is not unshipped" }]),
    ]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewCreate, labelArgs);
      const applied = await callTool(harness.mcp, TOOLS.applyCreate, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(true);
      expect(applied.json.neweggErrorCode).toBe("SL003");
      expect(applied.json.message).toContain("preview has been consumed");
    } finally {
      await harness.close();
    }
  });
});

describe("label reprint: preview -> apply", () => {
  it("previews with zero POSTs and applies the stored reprint once", async () => {
    const harness = await harnessFor(
      [postRoute(REPRINT, 200, reprintBody)],
      writesEnv(),
      undefined,
      true,
    );
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewReprint, {
        orderNumber: ORDER_NUMBER,
      });
      expect(preview.json).toMatchObject({
        operation: "shippingLabels.reprint",
        eligible: true,
        orderNumber: ORDER_NUMBER,
      });
      expect(posts(harness)).toHaveLength(0);

      const applied = await callTool(harness.mcp, TOOLS.applyReprint, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(false);
      expect(applied.json).toMatchObject({
        operation: "shippingLabels.reprint",
        orderNumber: ORDER_NUMBER,
        orderStatus: "Shipped",
        succeededCount: 1,
      });
      const pkg = (applied.json.packages as Array<Record<string, unknown>>)[0];
      expect(pkg).toMatchObject({ trackingNumber: TRACKING, labelUrl: LABEL_URL });
      const sent = posts(harness);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url.pathname).toBe(
        "/marketplace/can/shippingservice/shippinglabel/reprintshippinglabel",
      );
      expect(applied.text).not.toContain(CUSTOMER_SENTINEL);
    } finally {
      await harness.close();
    }
  });

  it("blocks the reprint of an order that has not shipped", async () => {
    const harness = await harnessFor([postRoute(REPRINT, 200, reprintBody)]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewReprint, {
        orderNumber: ORDER_NUMBER,
      });
      expect(preview.json.eligible).toBe(false);
      expect(preview.json.previewId).toBeUndefined();
      expect(posts(harness)).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("configuration", () => {
  it("keeps writes disabled unless NEWEGG_MCP_ALLOW_WRITES is exactly true", () => {
    expect(loadMcpConfigFromEnv(makeEnv()).allowWrites).toBe(false);
    expect(loadMcpConfigFromEnv(writesEnv()).allowWrites).toBe(true);
  });
});
