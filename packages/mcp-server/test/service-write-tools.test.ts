import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { loadMcpConfigFromEnv, type ServiceWritePreviewRecord } from "../src/index.js";
import { callTool, makeEnv, startHarness, type Harness } from "./helpers.js";
import {
  CUSTOMER_SENTINEL,
  NEW_RMA_NUMBER,
  ORDER_NUMBER,
  REQUEST_ID,
  RMA_NUMBER,
  SKU,
  TRACKING_SENTINEL,
  courtesyIssueBody,
  orderBody,
  readRoutes,
  rmaRecord,
  rmaWriteBody,
  type Reads,
} from "./service-write-fixtures.js";

/**
 * Mocked end-to-end coverage (real MCP client over an in-memory transport) of the RMA and
 * courtesy-refund write tools (contracts §20): the registration gate, preview -> apply (ADR 0005),
 * the refund ceiling, previewId misuse (unknown, replayed, expired, wrong tool, tampered), the
 * indeterminate-outcome contract and PII hygiene. Nothing here touches a real account.
 */
const writesEnv = (overrides: Record<string, string | undefined> = {}) =>
  makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true", ...overrides });

const TOOLS = {
  previewSubmit: "newegg_rma_preview_submit",
  applySubmit: "newegg_rma_apply_submit",
  previewEdit: "newegg_rma_preview_edit",
  applyEdit: "newegg_rma_apply_edit",
  previewProcess: "newegg_rma_preview_process",
  applyProcess: "newegg_rma_apply_process",
  previewReject: "newegg_rma_preview_reject",
  applyReject: "newegg_rma_apply_reject",
  previewRefund: "newegg_refund_preview_issue",
  applyRefund: "newegg_refund_apply_issue",
} as const;
const ALL = Object.values(TOOLS);

const postRoute = (pattern: RegExp, status: number, body: unknown): MockRoute => ({
  method: "POST",
  pathPattern: pattern,
  reply: () => ({ status, body }),
});

const NEW_RMA = /servicemgmt\/rma\/newrma/;
const UPDATE_RMA = /servicemgmt\/rma\/updaterma/;
const NEW_REFUND = /servicemgmt\/courtesyrefund\/new/;

function harnessFor(reads: Reads, writes: MockRoute[], env = writesEnv(), now?: () => Date) {
  return startHarness({ env, routes: [...readRoutes(reads), ...writes], now });
}

const posts = (harness: Harness) => harness.calls.filter((call) => call.method === "POST");

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
const refundArgs = {
  orderNumber: ORDER_NUMBER,
  reason: "customerCourtesy",
  amount: 25.5,
  noteToCustomer: "Sorry for the trouble",
};

describe("RMA / refund write tools - registration gate", () => {
  it("registers none of the ten tools when writes are disabled", async () => {
    for (const env of [
      makeEnv(),
      makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "false" }),
      makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "TRUE" }),
    ]) {
      const harness = await startHarness({ env, routes: [] });
      try {
        const { tools } = (await harness.mcp.listTools()) as { tools: Array<{ name: string }> };
        const names = tools.map((tool) => tool.name);
        for (const name of ALL) expect(names, name).not.toContain(name);
        const capabilities = JSON.parse(
          (
            (await harness.mcp.readResource({ uri: "newegg://capabilities" })) as {
              contents: Array<{ text?: string }>;
            }
          ).contents[0]?.text ?? "{}",
        ) as { mcpTools: string[] };
        for (const name of ALL) expect(capabilities.mcpTools, name).not.toContain(name);
        // An apply call cannot reach a tool that was never registered.
        const direct = await callTool(harness.mcp, TOOLS.applyRefund, { previewId: "x" });
        expect(direct.isError).toBe(true);
        expect(harness.calls).toHaveLength(0);
      } finally {
        await harness.close();
      }
    }
  });

  it("registers all ten with writes enabled: previews read-only, applies destructive and non-idempotent", async () => {
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
      for (const name of ALL) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool, name).toBeDefined();
        const isApply = name.includes("_apply_");
        expect(tool!.annotations?.readOnlyHint, name).toBe(!isApply);
        // Every description warns about money / customer returns.
        expect(tool!.description, name).toMatch(/customer|money|refund/i);
        expect(tool!.description, name).toContain("WARNING");
        if (isApply) {
          expect(tool!.annotations?.destructiveHint, name).toBe(true);
          expect(tool!.annotations?.idempotentHint, name).toBe(false);
          expect(tool!.description, name).toContain("writes enabled");
        }
      }
    } finally {
      await harness.close();
    }
  });
});

describe("courtesy refund: preview -> apply", () => {
  it("previews with zero writes, then applies exactly the stored request once", async () => {
    const harness = await harnessFor({}, [postRoute(NEW_REFUND, 200, courtesyIssueBody)]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewRefund, refundArgs);
      expect(preview.isError).toBe(false);
      expect(preview.structuredContent).toEqual(preview.json);
      expect(preview.json).toMatchObject({
        mode: "preview",
        operation: "refunds.issue",
        eligible: true,
        refundTotal: 25.5,
        currency: "CAD",
        maxRefundAmount: 500,
        blockers: [],
      });
      expect(typeof preview.json.previewId).toBe("string");
      expect(posts(harness)).toHaveLength(0);

      const applied = await callTool(harness.mcp, TOOLS.applyRefund, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(false);
      expect(applied.json).toMatchObject({
        mode: "apply",
        operation: "refunds.issue",
        courtesyRefund: {
          requestId: REQUEST_ID,
          state: "submitted",
          orderNumber: ORDER_NUMBER,
          amount: 25.5,
        },
      });
      const sent = posts(harness);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url.pathname).toBe("/marketplace/can/servicemgmt/courtesyrefund/new");
      expect(sent[0]!.bodyJson).toEqual({
        OperationType: "IssueCourtesyRefund",
        RequestBody: {
          IssueCourtesyRefund: {
            SourceSONumber: ORDER_NUMBER,
            RefundReason: "6",
            TotalRefundAmount: "25.50",
            NoteToCustomer: "Sorry for the trouble",
          },
        },
      });
    } finally {
      await harness.close();
    }
  });

  it("blocks a refund above NEWEGG_MCP_MAX_REFUND_AMOUNT and issues no previewId", async () => {
    const harness = await harnessFor(
      {},
      [postRoute(NEW_REFUND, 200, courtesyIssueBody)],
      writesEnv({
        NEWEGG_MCP_MAX_REFUND_AMOUNT: "20",
      }),
    );
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewRefund, refundArgs);
      expect(preview.json.eligible).toBe(false);
      expect(preview.json.previewId).toBeUndefined();
      expect(preview.json.maxRefundAmount).toBe(20);
      expect((preview.json.blockers as string[]).join("\n")).toContain(
        "NEWEGG_MCP_MAX_REFUND_AMOUNT",
      );
      // No previewId exists, so nothing can be applied.
      const applied = await callTool(harness.mcp, TOOLS.applyRefund, { previewId: "none" });
      expect(applied.json.errorCode).toBe("preview_not_found");
      expect(posts(harness)).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("issues no previewId when the SDK finds a blocker (voided order, over the balance)", async () => {
    const voided = await harnessFor({ order: orderBody({ OrderStatus: 4 }) }, []);
    try {
      const preview = await callTool(voided.mcp, TOOLS.previewRefund, refundArgs);
      expect(preview.json.eligible).toBe(false);
      expect(preview.json.previewId).toBeUndefined();
      expect((preview.json.blockers as string[]).join("\n")).toContain("SE027");
    } finally {
      await voided.close();
    }
    const over = await harnessFor({}, []);
    try {
      const preview = await callTool(over.mcp, TOOLS.previewRefund, { ...refundArgs, amount: 200 });
      expect((preview.json.blockers as string[]).join("\n")).toContain("SE023");
      expect(preview.json.previewId).toBeUndefined();
    } finally {
      await over.close();
    }
  });

  it("rejects invalid input at the schema (strict keys, bad money) before any call", async () => {
    const harness = await harnessFor({}, []);
    try {
      for (const bad of [
        { ...refundArgs, amount: 0 },
        { ...refundArgs, amount: -1 },
        { ...refundArgs, amount: 1.005 },
        { ...refundArgs, reason: "other" },
        { ...refundArgs, extra: true },
        { ...refundArgs, previewId: "x" },
      ]) {
        const res = await callTool(harness.mcp, TOOLS.previewRefund, bad);
        expect(res.isError).toBe(true);
      }
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("previewId misuse is rejected", () => {
  it("rejects an unknown id, a replay, a wrong-tool id and an expired id, sending nothing", async () => {
    let nowMs = Date.parse("2026-10-15T00:00:00Z");
    const harness = await harnessFor(
      { rmas: [rmaRecord()] },
      [
        postRoute(NEW_REFUND, 200, courtesyIssueBody),
        postRoute(UPDATE_RMA, 200, rmaWriteBody("ReceiveRMAResponse")),
      ],
      writesEnv(),
      () => new Date(nowMs),
    );
    try {
      const unknown = await callTool(harness.mcp, TOOLS.applyRefund, { previewId: "nope" });
      expect(unknown.json.errorCode).toBe("preview_not_found");

      // A previewId minted for an RMA receipt cannot be applied by the refund tool.
      const rmaPreview = await callTool(harness.mcp, TOOLS.previewProcess, {
        rmaNumber: RMA_NUMBER,
      });
      expect(rmaPreview.json.eligible).toBe(true);
      const wrong = await callTool(harness.mcp, TOOLS.applyRefund, {
        previewId: rmaPreview.json.previewId as string,
      });
      expect(wrong.json.errorCode).toBe("preview_kind_mismatch");
      // ...and that mismatch consumed it: the right tool can no longer use it either.
      const afterWrong = await callTool(harness.mcp, TOOLS.applyProcess, {
        previewId: rmaPreview.json.previewId as string,
      });
      expect(afterWrong.json.errorCode).toBe("preview_already_used");

      // Replay: apply once, then again.
      const refundPreview = await callTool(harness.mcp, TOOLS.previewRefund, refundArgs);
      const id = refundPreview.json.previewId as string;
      const first = await callTool(harness.mcp, TOOLS.applyRefund, { previewId: id });
      expect(first.isError).toBe(false);
      const replay = await callTool(harness.mcp, TOOLS.applyRefund, { previewId: id });
      expect(replay.json.errorCode).toBe("preview_already_used");
      expect(posts(harness)).toHaveLength(1);

      // Expiry (default TTL 600 s).
      const stale = await callTool(harness.mcp, TOOLS.previewRefund, refundArgs);
      nowMs += 601_000;
      const expired = await callTool(harness.mcp, TOOLS.applyRefund, {
        previewId: stale.json.previewId as string,
      });
      expect(expired.json.errorCode).toBe("preview_expired");
      expect(posts(harness)).toHaveLength(1);

      // The apply tools take only a previewId.
      const extra = await callTool(harness.mcp, TOOLS.applyRefund, { previewId: id, amount: 9999 });
      expect(extra.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("refuses a stored preview whose content no longer matches its hash", async () => {
    const harness = await harnessFor({}, [postRoute(NEW_REFUND, 200, courtesyIssueBody)]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewRefund, refundArgs);
      const id = preview.json.previewId as string;
      const stored = (await harness.previewStore.get(id)) as unknown as {
        input: { amount: number };
      };
      // Simulates a store that was tampered with between preview and apply.
      stored.input.amount = 90;
      const applied = await callTool(harness.mcp, TOOLS.applyRefund, { previewId: id });
      expect(applied.isError).toBe(true);
      expect(applied.json.errorCode).toBe("preview_tampered");
      expect(posts(harness)).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("stores records tagged with their kind", async () => {
    const harness = await harnessFor({}, []);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewRefund, refundArgs);
      const record = (await harness.previewStore.get(preview.json.previewId as string)) as
        ServiceWritePreviewRecord | undefined;
      expect(record?.kind).toBe("courtesyRefundIssue");
      expect(record?.marketplace).toBe("ca");
    } finally {
      await harness.close();
    }
  });
});

describe("indeterminate outcomes", () => {
  it("reports an unknown outcome with guidance, never retries, and burns the previewId", async () => {
    const harness = await harnessFor({}, [postRoute(NEW_REFUND, 503, "unavailable")]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewRefund, refundArgs);
      const id = preview.json.previewId as string;
      const applied = await callTool(harness.mcp, TOOLS.applyRefund, { previewId: id });
      expect(applied.isError).toBe(true);
      expect(applied.json.errorCode).toBe("service_write_indeterminate");
      expect(applied.json.retryable).toBe(false);
      expect(applied.json.message).toContain("Do NOT retry");
      expect(applied.json.message).toContain("refunds.listRequests");
      expect(posts(harness)).toHaveLength(1);
      const again = await callTool(harness.mcp, TOOLS.applyRefund, { previewId: id });
      expect(again.json.errorCode).toBe("preview_already_used");
      expect(posts(harness)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("passes a definitive Newegg error through with the consumed note", async () => {
    const harness = await harnessFor({}, [
      postRoute(NEW_REFUND, 400, [
        { Code: "SE019", Message: "Item total refund amount must be greater than 0" },
      ]),
    ]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewRefund, refundArgs);
      const applied = await callTool(harness.mcp, TOOLS.applyRefund, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(true);
      expect(applied.json.neweggErrorCode).toBe("SE019");
      expect(applied.json.message).toContain("preview has been consumed");
    } finally {
      await harness.close();
    }
  });
});

describe("RMA tools", () => {
  it("submit: previews the refund total, applies the stored RMA, and never returns customer data", async () => {
    const harness = await harnessFor({}, [
      postRoute(NEW_RMA, 200, rmaWriteBody("IssueRMAResponse", { RMANumber: NEW_RMA_NUMBER })),
    ]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewSubmit, submitArgs);
      expect(preview.json).toMatchObject({
        operation: "rma.submit",
        eligible: true,
        refundTotal: 40,
        orderNumber: ORDER_NUMBER,
      });
      expect(posts(harness)).toHaveLength(0);

      const applied = await callTool(harness.mcp, TOOLS.applySubmit, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(false);
      expect(applied.json).toMatchObject({
        mode: "apply",
        operation: "rma.submit",
        rma: { rmaNumber: NEW_RMA_NUMBER, type: "refund", status: "processing" },
      });
      const sent = posts(harness);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url.pathname).toBe("/marketplace/can/servicemgmt/rma/newrma");
      expect(sent[0]!.url.searchParams.get("version")).toBe("305");
      // No customer data, RMA note, memo or tracking number in either output.
      for (const text of [preview.text, applied.text]) {
        expect(text).not.toContain(CUSTOMER_SENTINEL);
        expect(text).not.toContain("NOTE-SENTINEL");
        expect(text).not.toContain("MEMO-SENTINEL");
        expect(text).not.toContain(TRACKING_SENTINEL);
      }
    } finally {
      await harness.close();
    }
  });

  it("submit: a refund above the order balance or the server ceiling is not eligible", async () => {
    const harness = await harnessFor(
      {},
      [postRoute(NEW_RMA, 200, rmaWriteBody("IssueRMAResponse"))],
      writesEnv({
        NEWEGG_MCP_MAX_REFUND_AMOUNT: "30",
      }),
    );
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewSubmit, submitArgs);
      expect(preview.json.eligible).toBe(false);
      expect((preview.json.blockers as string[]).join("\n")).toContain(
        "NEWEGG_MCP_MAX_REFUND_AMOUNT",
      );
      const tooMuch = await callTool(harness.mcp, TOOLS.previewSubmit, {
        ...submitArgs,
        items: [{ ...submitArgs.items[0]!, returnUnitPrice: 60 }],
      });
      expect((tooMuch.json.blockers as string[]).join("\n")).toContain("SE011");
      expect(posts(harness)).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("submit: autoReceive is not part of the MCP input", async () => {
    const harness = await harnessFor({}, []);
    try {
      const res = await callTool(harness.mcp, TOOLS.previewSubmit, {
        ...submitArgs,
        autoReceive: true,
      });
      expect(res.isError).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("edit: previews old versus new refund and applies EditRMARequest", async () => {
    const harness = await harnessFor({ rmas: [rmaRecord()] }, [
      postRoute(UPDATE_RMA, 200, rmaWriteBody("EditRMAResponse")),
    ]);
    try {
      const args = {
        rmaNumber: RMA_NUMBER,
        type: "refund",
        note: "adjusted",
        items: [{ ...submitArgs.items[0]!, returnUnitPrice: 30 }],
      };
      const preview = await callTool(harness.mcp, TOOLS.previewEdit, args);
      expect(preview.json).toMatchObject({
        eligible: true,
        refundTotal: 30,
        rmaNumber: RMA_NUMBER,
      });
      expect((preview.json.warnings as string[]).join("\n")).toContain("currently refunds 50.00");
      const applied = await callTool(harness.mcp, TOOLS.applyEdit, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(false);
      expect(applied.json).toMatchObject({ operation: "rma.edit", rma: { rmaNumber: RMA_NUMBER } });
      expect((posts(harness)[0]!.bodyJson as { OperationType: string }).OperationType).toBe(
        "EditRMARequest",
      );
    } finally {
      await harness.close();
    }
  });

  it("process: previews the refund it releases and applies ReceiveRMARequest; a closed RMA is blocked", async () => {
    const open = await harnessFor({ rmas: [rmaRecord()] }, [
      postRoute(UPDATE_RMA, 200, rmaWriteBody("ReceiveRMAResponse")),
    ]);
    try {
      const preview = await callTool(open.mcp, TOOLS.previewProcess, { rmaNumber: RMA_NUMBER });
      expect(preview.json).toMatchObject({ eligible: true, refundTotal: 50 });
      const applied = await callTool(open.mcp, TOOLS.applyProcess, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.json).toMatchObject({ operation: "rma.receive" });
      expect(posts(open)[0]!.bodyJson).toEqual({
        OperationType: "ReceiveRMARequest",
        RequestBody: { ReceiveRMAInfo: { RMANumber: RMA_NUMBER } },
      });
    } finally {
      await open.close();
    }
    const closed = await harnessFor({ rmas: [rmaRecord({ RMAStatus: "5" })] }, []);
    try {
      const preview = await callTool(closed.mcp, TOOLS.previewProcess, { rmaNumber: RMA_NUMBER });
      expect(preview.json.eligible).toBe(false);
      expect((preview.json.blockers as string[]).join("\n")).toContain("SE028");
      expect(preview.json.previewId).toBeUndefined();
    } finally {
      await closed.close();
    }
  });

  it("process: a refund RMA above the server ceiling is not eligible", async () => {
    const harness = await harnessFor(
      { rmas: [rmaRecord()] },
      [],
      writesEnv({
        NEWEGG_MCP_MAX_REFUND_AMOUNT: "49.99",
      }),
    );
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewProcess, { rmaNumber: RMA_NUMBER });
      expect(preview.json.eligible).toBe(false);
      expect(preview.json.previewId).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("process: a refund RMA whose amounts cannot be read is blocked, not waved through", async () => {
    const unreadable = rmaRecord({ RMATransactionList: "" });
    const harness = await harnessFor({ rmas: [unreadable] }, []);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewProcess, { rmaNumber: RMA_NUMBER });
      expect(preview.json.eligible).toBe(false);
      expect(preview.json.previewId).toBeUndefined();
      expect((preview.json.blockers as string[]).join("\n")).toContain("could not be read");
    } finally {
      await harness.close();
    }
  });

  it("process: aborts at apply when the RMA refund changed after the preview", async () => {
    const reads: Reads = { rmas: [rmaRecord()] };
    const harness = await harnessFor(reads, [
      postRoute(UPDATE_RMA, 200, rmaWriteBody("ReceiveRMAResponse")),
    ]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewProcess, { rmaNumber: RMA_NUMBER });
      expect(preview.json).toMatchObject({ eligible: true, refundTotal: 50 });
      // The RMA is edited upwards inside the TTL (still under the ceiling of 500).
      reads.rmas = [
        rmaRecord({
          RMATransactionList: {
            RMATransaction: {
              SellerPartNumber: SKU,
              UnitPrice: "50.00",
              ReturnQuantity: "1",
              ReturnUnitPrice: "400.00",
              RefundShippingPrice: "0.00",
              RMAReason: "2",
            },
          },
        }),
      ];
      const applied = await callTool(harness.mcp, TOOLS.applyProcess, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(true);
      expect(applied.json.errorCode).toBe("preview_stale");
      expect(String(applied.json.message)).toContain("changed since the preview");
      expect(posts(harness)).toHaveLength(0);
      // Single use: the preview is consumed even though nothing was sent.
      const replay = await callTool(harness.mcp, TOOLS.applyProcess, {
        previewId: preview.json.previewId as string,
      });
      expect(replay.json.errorCode).toBe("preview_already_used");
    } finally {
      await harness.close();
    }
  });

  it("process: aborts at apply when the RMA is no longer open", async () => {
    const reads: Reads = { rmas: [rmaRecord()] };
    const harness = await harnessFor(reads, [
      postRoute(UPDATE_RMA, 200, rmaWriteBody("ReceiveRMAResponse")),
    ]);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewProcess, { rmaNumber: RMA_NUMBER });
      reads.rmas = [rmaRecord({ RMAStatus: "5" })];
      const applied = await callTool(harness.mcp, TOOLS.applyProcess, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(true);
      expect(applied.json.errorCode).toBe("preview_stale");
      expect(posts(harness)).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("reject: previews the denial and applies RejectRMARequest with the marketplace's reason code", async () => {
    const harness = await harnessFor({ rmas: [rmaRecord()] }, [
      postRoute(UPDATE_RMA, 200, rmaWriteBody("RejectRMAResponse")),
    ]);
    try {
      const args = {
        rmaNumber: RMA_NUMBER,
        reason: "customerRequest",
        carrier: "ups",
        shipService: "Ground",
        trackingNumbers: ["RETURN-TRACK-0001"],
      };
      const preview = await callTool(harness.mcp, TOOLS.previewReject, args);
      expect(preview.json.eligible).toBe(true);
      expect((preview.json.warnings as string[]).join("\n")).toContain("denies the customer");
      const applied = await callTool(harness.mcp, TOOLS.applyReject, {
        previewId: preview.json.previewId as string,
      });
      expect(applied.isError).toBe(false);
      expect(applied.text).not.toContain(TRACKING_SENTINEL);
      expect(applied.text).not.toContain("RETURN-TRACK-0001");
      expect(posts(harness)[0]!.bodyJson).toMatchObject({
        OperationType: "RejectRMARequest",
        RequestBody: { RejectRMAInfo: { RejectReason: "16", ShipCarrier: "1" } },
      });
    } finally {
      await harness.close();
    }
  });

  it("reject: a reason that is not available on this marketplace fails at preview", async () => {
    const harness = await harnessFor({ rmas: [rmaRecord()] }, []);
    try {
      const preview = await callTool(harness.mcp, TOOLS.previewReject, {
        rmaNumber: RMA_NUMBER,
        reason: "unlockedCellphone",
        carrier: "ups",
        shipService: "Ground",
        trackingNumbers: ["T1"],
      });
      expect(preview.isError).toBe(true);
      expect(preview.json.errorCode).toBe("validation");
    } finally {
      await harness.close();
    }
  });
});

describe("NEWEGG_MCP_MAX_REFUND_AMOUNT config", () => {
  it("defaults to 500 and accepts a decimal", () => {
    expect(loadMcpConfigFromEnv(makeEnv()).limits.maxRefundAmount).toBe(500);
    expect(
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_MAX_REFUND_AMOUNT: "12.5" })).limits
        .maxRefundAmount,
    ).toBe(12.5);
  });

  it.each(["0", "-1", "abc", "100000"])("rejects %s", (value) => {
    expect(() => loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_MAX_REFUND_AMOUNT: value }))).toThrow(
      /NEWEGG_MCP_MAX_REFUND_AMOUNT/,
    );
  });
});
