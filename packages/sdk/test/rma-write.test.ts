import { describe, expect, it } from "vitest";
import {
  IndeterminateServiceWriteError,
  NeweggApiError,
  NeweggValidationError,
  type NeweggMarketplace,
  type SubmitRmaInput,
} from "../src/index.js";
import type { MockRoute } from "../src/testing/index.js";
import { makeClient, paths } from "./helpers.js";
import {
  EXISTING_RMA_NUMBER,
  NEW_RMA_NUMBER,
  ORDER_NUMBER,
  SKU,
  courtesyRecord,
  orderResponse,
  readRoutes,
  rmaRecord,
  rmaWriteResponse,
  type ReadFixtures,
} from "./service-write-helpers.js";

/**
 * Mocked coverage for the RMA WRITES (contracts §20): Submit, Edit, Process (receive) and Reject
 * RMA. Nothing here touches a real account. The safety properties asserted explicitly: previews
 * never POST; a blocker stops the write before any POST; an ambiguous failure becomes an
 * IndeterminateServiceWriteError and is never resent; definitive 4xx errors pass through.
 */
const submitInput: SubmitRmaInput = {
  orderNumber: ORDER_NUMBER,
  type: "refund",
  sellerRmaNumber: "SELLERRMA1",
  note: "customer reported a fault",
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

function setup(
  marketplace: NeweggMarketplace,
  writeRoutes: MockRoute[],
  fixtures: ReadFixtures = {},
) {
  return makeClient(marketplace, [...readRoutes(fixtures), ...writeRoutes]);
}

const submitOk: MockRoute = {
  method: "POST",
  pathPattern: paths.rmaNew,
  reply: () => ({ status: 200, body: rmaWriteResponse() }),
};

const updateOk = (operationType: string, info: Record<string, unknown> = {}): MockRoute => ({
  method: "POST",
  pathPattern: paths.rmaUpdate,
  reply: () => ({
    status: 200,
    body: rmaWriteResponse({ RMANumber: EXISTING_RMA_NUMBER, ...info }, operationType),
  }),
});

const posts = <T extends { method: string }>(calls: T[]): T[] =>
  calls.filter((c) => c.method === "POST");

describe("rma.previewSubmit", () => {
  it("only reads: no POST is ever sent, and the plan reports the refund total", async () => {
    const { client, calls } = setup("ca", [submitOk]);
    const preview = await client.rma.previewSubmit(submitInput);
    expect(preview.blockers).toEqual([]);
    expect(preview.operation).toBe("rma.submit");
    expect(preview.refundTotal).toBe(40);
    expect(preview.currency).toBe("CAD");
    expect(preview.orderNumber).toBe(ORDER_NUMBER);
    expect(preview.normalized.items[0]?.returnUnitPrice).toBe(40);
    expect(posts(calls)).toHaveLength(0);
    expect(calls.every((c) => c.method === "PUT")).toBe(true);
  });

  it("blocks a refund per unit above the item's unit price and a total above the order", async () => {
    const { client } = setup("ca", []);
    const preview = await client.rma.previewSubmit({
      ...submitInput,
      items: [
        {
          ...submitInput.items[0]!,
          returnQuantity: 2,
          returnUnitPrice: 50.01,
          refundShippingPrice: 20,
        },
      ],
    });
    const text = preview.blockers.join("\n");
    expect(text).toContain("SE011");
    expect(text).toContain("SE012");
    expect(text).toContain("SE023");
  });

  it("blocks when the order total is unknown (fail closed)", async () => {
    const { client } = setup("ca", [], { order: orderResponse({ OrderTotalAmount: undefined }) });
    const preview = await client.rma.previewSubmit(submitInput);
    expect(preview.blockers.join("\n")).toContain("order total is unknown");
  });

  it("blocks when a prior refund line has no readable price instead of counting it as 0", async () => {
    const unpriced = rmaRecord({
      RMATransactionList: { RMATransaction: { SellerPartNumber: SKU, ReturnQuantity: "1" } },
    });
    const { client, calls } = setup("ca", [submitOk], { rmas: [unpriced] });
    const preview = await client.rma.previewSubmit(submitInput);
    expect(preview.blockers.join("\n")).toContain("cannot be reconciled");
    await expect(client.rma.submit(submitInput)).rejects.toBeInstanceOf(NeweggValidationError);
    expect(posts(calls)).toHaveLength(0);
  });

  it("warns, without blocking, when a prior refund line has an unknown shipping refund", async () => {
    const noShipping = rmaRecord({
      RMATransactionList: {
        RMATransaction: {
          SellerPartNumber: SKU,
          UnitPrice: "50.00",
          ReturnQuantity: "1",
          ReturnUnitPrice: "20.00",
        },
      },
    });
    const { client } = setup("ca", [], { rmas: [noShipping] });
    const preview = await client.rma.previewSubmit(submitInput);
    expect(preview.blockers).toEqual([]);
    const warning = preview.warnings.find((w) => w.includes("shipping refund"));
    expect(warning).toContain(EXISTING_RMA_NUMBER);
    expect(warning).toContain("counted as 0");
  });

  it("does not warn about shipping when every prior refund line records its shipping refund", async () => {
    const { client } = setup("ca", [], { rmas: [rmaRecord()] });
    const preview = await client.rma.previewSubmit(submitInput);
    expect(preview.warnings.some((w) => w.includes("shipping refund of prior"))).toBe(false);
  });

  it("blocks when a prior refund RMA carries no lines at all", async () => {
    const { client } = setup("ca", [], { rmas: [rmaRecord({ RMATransactionList: "" })] });
    const preview = await client.rma.previewSubmit(submitInput);
    expect(preview.blockers.join("\n")).toContain("cannot be reconciled");
  });

  it("does not block on a prior replacement RMA or a rejected unpriced one", async () => {
    const replacement = rmaRecord({ RMAType: "1", RMATransactionList: "" });
    const rejected = rmaRecord({ RMANumber: "900000012", RMAStatus: "3", RMATransactionList: "" });
    const { client } = setup("ca", [], { rmas: [replacement, rejected] });
    const preview = await client.rma.previewSubmit(submitInput);
    expect(preview.blockers).toEqual([]);
  });

  it("warns, without blocking, that a replacement RMA may need DiffShippedByPartyAction", async () => {
    const { client } = setup("ca", [submitOk]);
    const replacement: SubmitRmaInput = {
      orderNumber: ORDER_NUMBER,
      type: "replacement",
      items: [{ sellerPartNumber: SKU, returnQuantity: 1, reason: "defective" }],
    };
    const preview = await client.rma.previewSubmit(replacement);
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings.join("\n")).toContain("DiffShippedByPartyAction");
  });

  it("blocks a quantity above what is left after other RMAs and ignores rejected ones", async () => {
    const other = rmaRecord({
      RMATransactionList: {
        RMATransaction: { SellerPartNumber: SKU, ReturnQuantity: "1", ReturnUnitPrice: "10.00" },
      },
    });
    const rejected = rmaRecord({ RMANumber: "900000012", RMAStatus: "3" });
    const { client } = setup("ca", [], { rmas: [other, rejected] });
    const fine = await client.rma.previewSubmit(submitInput);
    expect(fine.blockers).toEqual([]);
    expect(fine.warnings.join("\n")).toContain("already has 1 RMA");
    const tooMany = await client.rma.previewSubmit({
      ...submitInput,
      items: [{ ...submitInput.items[0]!, returnQuantity: 2 }],
    });
    expect(tooMany.blockers.join("\n")).toContain("SE009");
  });

  it("caps the refund at the order total minus prior RMA and courtesy refunds", async () => {
    const { client } = setup("ca", [], {
      rmas: [
        rmaRecord({
          RMATransactionList: {
            RMATransaction: {
              SellerPartNumber: "SKU-OTHER",
              ReturnQuantity: "1",
              ReturnUnitPrice: "60.00",
              RefundShippingPrice: "0.00",
            },
          },
        }),
      ],
      courtesyRefunds: [courtesyRecord({ RefundAmount: "20.00" })],
    });
    // 110 - 60 - 20 = 30 left; a 40 refund is too much.
    const preview = await client.rma.previewSubmit(submitInput);
    expect(preview.blockers.join("\n")).toContain("SE034");
    expect(preview.warnings.join("\n")).toContain("courtesy refund");
  });

  it("blocks a missing, voided, unshipped or replacement order and unknown items", async () => {
    const missing = setup("ca", [], { order: null });
    expect((await missing.client.rma.previewSubmit(submitInput)).blockers.join("\n")).toContain(
      "no such order",
    );
    for (const [overrides, code] of [
      [{ OrderStatus: 4, OrderStatusDescription: "Voided" }, "SE027"],
      [{ OrderStatus: 0, OrderStatusDescription: "Unshipped" }, "SE004"],
      [{ SalesChannel: 2 }, "SE026"],
    ] as const) {
      const { client } = setup("ca", [], { order: orderResponse(overrides) });
      expect((await client.rma.previewSubmit(submitInput)).blockers.join("\n")).toContain(code);
    }
    const { client } = setup("ca", []);
    const unknown = await client.rma.previewSubmit({
      ...submitInput,
      items: [{ ...submitInput.items[0]!, sellerPartNumber: "NOT-ON-ORDER" }],
    });
    expect(unknown.blockers.join("\n")).toContain("not an item on the order");
  });

  it("warns that autoReceive finalizes the refund and blocks it on a Newegg-fulfilled order", async () => {
    const seller = setup("ca", []);
    const ok = await seller.client.rma.previewSubmit({ ...submitInput, autoReceive: true });
    expect(ok.blockers).toEqual([]);
    expect(ok.warnings.join("\n")).toContain("autoReceive finalizes the refund");
    const newegg = setup("ca", [], { order: orderResponse({ FulfillmentOption: 1 }) });
    const blocked = await newegg.client.rma.previewSubmit({ ...submitInput, autoReceive: true });
    expect(blocked.blockers.join("\n")).toContain("SE031");
  });
});

describe("rma.submit", () => {
  it("POSTs the documented IssueRMARequest to the Canada endpoint with version 305", async () => {
    const { client, calls } = setup("ca", [submitOk]);
    const result = await client.rma.submit(submitInput);

    const post = posts(calls);
    expect(post).toHaveLength(1);
    expect(post[0]!.url.pathname).toBe("/marketplace/can/servicemgmt/rma/newrma");
    expect(post[0]!.url.searchParams.get("sellerid")).toBe("A006");
    expect(post[0]!.url.searchParams.get("version")).toBe("305");
    expect(post[0]!.bodyJson).toEqual({
      OperationType: "IssueRMARequest",
      RequestBody: {
        IssueRMA: {
          RMAType: "2",
          SourceSONumber: ORDER_NUMBER,
          SellerRMANumber: "SELLERRMA1",
          RMANote: "customer reported a fault",
          RMATransactionList: {
            RMATransaction: {
              SellerPartNumber: SKU,
              ReturnQuantity: "1",
              ReturnUnitPrice: "40.00",
              RefundShippingPrice: "0.00",
              RMAReason: "2",
            },
          },
        },
      },
    });
    expect(result).toMatchObject({
      operation: "rma.submit",
      rmaNumber: NEW_RMA_NUMBER,
      type: "refund",
      status: "processing",
      orderNumber: ORDER_NUMBER,
      currency: "CAD",
    });
    expect(result.items[0]).toMatchObject({ sellerPartNumber: SKU, returnUnitPrice: 40 });
  });

  it("uses no prefix and version 307 on Newegg.com, and the b2b prefix with 305", async () => {
    const us = setup("us", [submitOk]);
    await us.client.rma.submit(submitInput);
    const usPost = posts(us.calls)[0]!;
    expect(usPost.url.pathname).toBe("/marketplace/servicemgmt/rma/newrma");
    expect(usPost.url.searchParams.get("version")).toBe("307");

    const b2b = setup("b2b", [submitOk]);
    await b2b.client.rma.submit(submitInput);
    const b2bPost = posts(b2b.calls)[0]!;
    expect(b2bPost.url.pathname).toBe("/marketplace/b2b/servicemgmt/rma/newrma");
    expect(b2bPost.url.searchParams.get("version")).toBe("305");
  });

  it("sends the evidence block for reason 6 and an array for several lines", async () => {
    const { client, calls } = setup("ca", [submitOk], {
      order: orderResponse({
        ItemInfoList: [
          { SellerPartNumber: SKU, OrderedQty: 2, ShippedQty: 2, UnitPrice: "50.00", Status: 2 },
          { SellerPartNumber: "SKU-B", OrderedQty: 1, ShippedQty: 1, UnitPrice: "5.00", Status: 2 },
        ],
      }),
    });
    await client.rma.submit({
      orderNumber: Number(ORDER_NUMBER),
      type: "refund",
      autoReceive: true,
      items: [
        {
          sellerPartNumber: SKU,
          returnQuantity: 1,
          reason: "orderedWrongItem",
          returnUnitPrice: 40,
          refundShippingPrice: 0,
          unopened: true,
          imageUrls: ["https://example.invalid/a.jpg"],
          memo: "ordered wrong item",
        },
        {
          sellerPartNumber: "SKU-B",
          returnQuantity: 1,
          reason: "defective",
          returnUnitPrice: 5,
          refundShippingPrice: 0,
        },
      ],
    });
    const body = posts(calls)[0]!.bodyJson as {
      RequestBody: { IssueRMA: Record<string, unknown> };
    };
    expect(body.RequestBody.IssueRMA.AutoReceiveMark).toBe("1");
    const list = (body.RequestBody.IssueRMA.RMATransactionList as { RMATransaction: unknown[] })
      .RMATransaction;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      RMAReason: "6",
      UnOpen: "1",
      FileUrls: { ImgUrl: ["https://example.invalid/a.jpg"] },
      Memo: "ordered wrong item",
    });
  });

  it("sends a replacement RMA without any money fields", async () => {
    const { client, calls } = setup("ca", [submitOk]);
    await client.rma.submit({
      orderNumber: ORDER_NUMBER,
      type: "replacement",
      items: [{ sellerPartNumber: SKU, returnQuantity: 1, reason: "sentWrongItem" }],
    });
    const issue = (
      posts(calls)[0]!.bodyJson as { RequestBody: { IssueRMA: Record<string, unknown> } }
    ).RequestBody.IssueRMA;
    expect(issue.RMAType).toBe("1");
    expect(issue.RMATransactionList).toEqual({
      RMATransaction: { SellerPartNumber: SKU, ReturnQuantity: "1", RMAReason: "7" },
    });
  });

  it("refuses to POST when a pre-send check blocks, with every blocker in the error", async () => {
    const { client, calls } = setup("ca", [submitOk]);
    const err = await client.rma
      .submit({ ...submitInput, items: [{ ...submitInput.items[0]!, returnUnitPrice: 99 }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggValidationError);
    expect((err as NeweggValidationError).issues.map((i) => i.message).join("\n")).toContain(
      "SE011",
    );
    expect(posts(calls)).toHaveLength(0);
  });

  it("throws IndeterminateServiceWriteError on an ambiguous 503 and does NOT retry", async () => {
    const { client, calls } = setup("ca", [
      { method: "POST", pathPattern: paths.rmaNew, reply: () => ({ status: 503, body: "down" }) },
    ]);
    const err = await client.rma.submit(submitInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndeterminateServiceWriteError);
    const indeterminate = err as IndeterminateServiceWriteError;
    expect(indeterminate.code).toBe("service_write_indeterminate");
    expect(indeterminate.retryable).toBe(false);
    expect(indeterminate.operation).toBe("rma.submit");
    expect(indeterminate.orderNumber).toBe(ORDER_NUMBER);
    expect(indeterminate.guidance).toContain("rma.list");
    expect(posts(calls)).toHaveLength(1);
  });

  it.each([500, 501, 599])(
    "treats a plain HTTP %i after dispatch as indeterminate, never definitive",
    async (status) => {
      const { client, calls } = setup("ca", [
        { method: "POST", pathPattern: paths.rmaNew, reply: () => ({ status, body: "oops" }) },
      ]);
      const err = await client.rma.submit(submitInput).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndeterminateServiceWriteError);
      expect((err as IndeterminateServiceWriteError).retryable).toBe(false);
      expect(posts(calls)).toHaveLength(1);
    },
  );

  it("treats a caller abort after dispatch as indeterminate, not a clean cancellation", async () => {
    const controller = new AbortController();
    const { client, calls } = setup("ca", [
      {
        method: "POST",
        pathPattern: paths.rmaNew,
        reply: () => {
          controller.abort();
          throw new DOMException("This operation was aborted", "AbortError");
        },
      },
    ]);
    const err = await client.rma
      .submit(submitInput, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndeterminateServiceWriteError);
    expect((err as IndeterminateServiceWriteError).retryable).toBe(false);
    expect(posts(calls)).toHaveLength(1);
  });

  it("rethrows the raw abort when the signal was aborted before anything was dispatched", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, calls } = setup("ca", [submitOk]);
    const err = await client.rma
      .submit(submitInput, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(IndeterminateServiceWriteError);
    expect((err as { name?: string }).name).toBe("AbortError");
    expect(posts(calls)).toHaveLength(0);
  });

  it("throws IndeterminateServiceWriteError when the connection resets after dispatch", async () => {
    const { client, calls } = setup("ca", [
      {
        method: "POST",
        pathPattern: paths.rmaNew,
        reply: () => {
          throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        },
      },
    ]);
    const err = await client.rma.submit(submitInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndeterminateServiceWriteError);
    expect(posts(calls)).toHaveLength(1);
  });

  it("treats a 2xx response that does not identify the RMA as indeterminate", async () => {
    const { client, calls } = setup("ca", [
      {
        method: "POST",
        pathPattern: paths.rmaNew,
        reply: () => ({ status: 200, body: { IsSuccess: "true", ResponseBody: {} } }),
      },
    ]);
    const err = await client.rma.submit(submitInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndeterminateServiceWriteError);
    expect(posts(calls)).toHaveLength(1);
  });

  it("passes a definitive 4xx SE error through unchanged and sends once", async () => {
    const { client, calls } = setup("ca", [
      {
        method: "POST",
        pathPattern: paths.rmaNew,
        reply: () => ({
          status: 400,
          body: [
            { Code: "SE004", Message: "Cannot issue RMA because the order has not been invoiced" },
          ],
        }),
      },
    ]);
    const err = await client.rma.submit(submitInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggApiError);
    expect((err as NeweggApiError).neweggErrorCode).toBe("SE004");
    expect(posts(calls)).toHaveLength(1);
  });

  it("throws NeweggApiError when a 200 body says IsSuccess=false", async () => {
    const { client } = setup("ca", [
      {
        method: "POST",
        pathPattern: paths.rmaNew,
        reply: () => ({ status: 200, body: { IsSuccess: "false", Memo: "rejected" } }),
      },
    ]);
    await expect(client.rma.submit(submitInput)).rejects.toBeInstanceOf(NeweggApiError);
  });
});

describe("RMA write input validation (nothing is read or sent)", () => {
  const reject = async (input: unknown, marketplace: NeweggMarketplace = "ca") => {
    const { client, calls } = setup(marketplace, [submitOk]);
    const err = await client.rma.submit(input as SubmitRmaInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
    return (err as NeweggValidationError).issues.map((i) => `${i.path}: ${i.message}`).join("\n");
  };
  const line = submitInput.items[0]!;

  it("rejects bad money: zero, negative, three decimals, above the ceiling, NaN", async () => {
    for (const price of [0, -1, 1.005, 100000, Number.NaN]) {
      await reject({ ...submitInput, items: [{ ...line, returnUnitPrice: price }] });
    }
    expect(
      await reject({ ...submitInput, items: [{ ...line, refundShippingPrice: -0.01 }] }),
    ).toContain("refundShippingPrice");
    expect(
      await reject({ ...submitInput, items: [{ ...line, returnUnitPrice: 1.005 }] }),
    ).toContain("at most 2 decimal places");
  });

  it("requires prices on a refund and forbids them on a replacement", async () => {
    const { returnUnitPrice: _a, refundShippingPrice: _b, ...bare } = line;
    const refund = await reject({ ...submitInput, items: [bare] });
    expect(refund).toContain("items.0.returnUnitPrice: is required for a refund RMA");
    expect(refund).toContain("items.0.refundShippingPrice: is required");
    const replacement = await reject({ ...submitInput, type: "replacement" });
    expect(replacement).toContain("is only allowed on a refund RMA");
  });

  it("requires unopened, images and a memo for reasons 3 / 4 / 6 / 8 on Newegg.ca", async () => {
    for (const reason of ["incompatible", "noLongerNeeded", "orderedWrongItem", "unsatisfied"]) {
      const text = await reject({ ...submitInput, items: [{ ...line, reason }] });
      expect(text).toContain("unopened");
      expect(text).toContain("imageUrls");
      expect(text).toContain("memo");
    }
  });

  it("does not accept evidence images or memo on Neweggbusiness.com", async () => {
    const text = await reject(
      {
        ...submitInput,
        items: [{ ...line, memo: "m", imageUrls: ["https://example.invalid/a.png"] }],
      },
      "b2b",
    );
    expect(text).toContain("not accepted on the b2b marketplace");
  });

  it("rejects malformed numbers, duplicates, unknown keys, bad URLs and over-long text", async () => {
    expect(await reject({ ...submitInput, orderNumber: "12ab" })).toContain("orderNumber");
    expect(await reject({ ...submitInput, orderNumber: 0 })).toContain("orderNumber");
    expect(await reject({ ...submitInput, items: [line, line] })).toContain("more than one line");
    expect(await reject({ ...submitInput, items: [] })).toContain("items");
    expect(await reject({ ...submitInput, extra: true })).toContain("extra");
    expect(await reject({ ...submitInput, sellerRmaNumber: "bad number!" })).toContain(
      "sellerRmaNumber",
    );
    expect(await reject({ ...submitInput, note: "x".repeat(4001) })).toContain("note");
    expect(
      await reject({
        ...submitInput,
        items: [{ ...line, imageUrls: ["ftp://example.invalid/a.png"] }],
      }),
    ).toContain("http(s)");
    expect(await reject({ ...submitInput, items: [{ ...line, returnQuantity: 0 }] })).toContain(
      "returnQuantity",
    );
    expect(
      await reject({
        ...submitInput,
        type: "replacement",
        autoReceive: true,
        items: [{ sellerPartNumber: SKU, returnQuantity: 1, reason: "sentWrongItem" }],
      }),
    ).toContain("autoReceive");
  });
});

describe("rma.edit", () => {
  const editInput = {
    rmaNumber: EXISTING_RMA_NUMBER,
    type: "refund" as const,
    note: "adjusted refund",
    items: [
      {
        sellerPartNumber: SKU,
        returnQuantity: 1,
        reason: "defective" as const,
        returnUnitPrice: 30,
        refundShippingPrice: 0,
      },
    ],
  };

  it("POSTs EditRMARequest to updaterma and does not count the edited RMA against the balance", async () => {
    const { client, calls } = setup("ca", [updateOk("EditRMAResponse")], {
      rmas: [rmaRecord()],
    });
    const preview = await client.rma.previewEdit(editInput);
    expect(preview.blockers).toEqual([]);
    expect(preview.refundTotal).toBe(30);
    expect(preview.warnings.join("\n")).toContain("currently refunds 50.00");
    expect(posts(calls)).toHaveLength(0);

    const result = await client.rma.edit(editInput);
    const post = posts(calls);
    expect(post).toHaveLength(1);
    expect(post[0]!.url.pathname).toBe("/marketplace/can/servicemgmt/rma/updaterma");
    expect(post[0]!.url.searchParams.get("version")).toBe("305");
    expect(post[0]!.bodyJson).toEqual({
      OperationType: "EditRMARequest",
      RequestBody: {
        EditRMAInfo: {
          RMANumber: EXISTING_RMA_NUMBER,
          RMAType: "2",
          RMANote: "adjusted refund",
          RMATransactionList: {
            RMATransaction: {
              SellerPartNumber: SKU,
              ReturnQuantity: "1",
              ReturnUnitPrice: "30.00",
              RefundShippingPrice: "0.00",
              RMAReason: "2",
            },
          },
        },
      },
    });
    expect(result).toMatchObject({ operation: "rma.edit", rmaNumber: EXISTING_RMA_NUMBER });
  });

  it("blocks an unknown RMA, a closed RMA and a type change, without sending", async () => {
    const none = setup("ca", [updateOk("EditRMAResponse")]);
    expect((await none.client.rma.previewEdit(editInput)).blockers.join("\n")).toContain(
      "no such RMA",
    );
    const closed = setup("ca", [updateOk("EditRMAResponse")], {
      rmas: [rmaRecord({ RMAStatus: "5" })],
    });
    expect((await closed.client.rma.previewEdit(editInput)).blockers.join("\n")).toContain("SE028");
    const typed = setup("ca", [updateOk("EditRMAResponse")], {
      rmas: [rmaRecord({ RMAType: "1" })],
    });
    const text = (await typed.client.rma.previewEdit(editInput)).blockers.join("\n");
    expect(text).toContain("type cannot be changed");
    await expect(typed.client.rma.edit(editInput)).rejects.toBeInstanceOf(NeweggValidationError);
    expect(posts(typed.calls)).toHaveLength(0);
  });

  it("requires a note", async () => {
    const { client } = setup("ca", [], { rmas: [rmaRecord()] });
    await expect(
      client.rma.previewEdit({ ...editInput, note: "" } as typeof editInput),
    ).rejects.toBeInstanceOf(NeweggValidationError);
  });
});

describe("rma.process (receive)", () => {
  it("POSTs ReceiveRMARequest and previews the refund it will release", async () => {
    const { client, calls } = setup("us", [updateOk("ReceiveRMAResponse")], {
      rmas: [rmaRecord()],
    });
    const preview = await client.rma.previewProcess({ rmaNumber: Number(EXISTING_RMA_NUMBER) });
    expect(preview.blockers).toEqual([]);
    expect(preview.refundTotal).toBe(50);
    expect(preview.currency).toBe("USD");
    expect(preview.warnings.join("\n")).toContain("refund the customer 50.00");
    expect(posts(calls)).toHaveLength(0);

    const result = await client.rma.process({ rmaNumber: EXISTING_RMA_NUMBER });
    const post = posts(calls)[0]!;
    expect(post.url.pathname).toBe("/marketplace/servicemgmt/rma/updaterma");
    expect(post.url.searchParams.get("version")).toBe("307");
    expect(post.bodyJson).toEqual({
      OperationType: "ReceiveRMARequest",
      RequestBody: { ReceiveRMAInfo: { RMANumber: EXISTING_RMA_NUMBER } },
    });
    expect(result.operation).toBe("rma.receive");
  });

  it("refuses an RMA that is not open (SE028) and one that does not exist", async () => {
    for (const status of ["2", "3", "4", "5"]) {
      const { client, calls } = setup("ca", [updateOk("ReceiveRMAResponse")], {
        rmas: [rmaRecord({ RMAStatus: status })],
      });
      await expect(client.rma.process({ rmaNumber: EXISTING_RMA_NUMBER })).rejects.toBeInstanceOf(
        NeweggValidationError,
      );
      expect(posts(calls)).toHaveLength(0);
    }
    const { client } = setup("ca", [updateOk("ReceiveRMAResponse")]);
    const preview = await client.rma.previewProcess({ rmaNumber: EXISTING_RMA_NUMBER });
    expect(preview.blockers.join("\n")).toContain("no such RMA");
  });

  it("is indeterminate when the response names a different RMA, and never retries a 504", async () => {
    const wrong = setup("ca", [updateOk("ReceiveRMAResponse", { RMANumber: "999" })], {
      rmas: [rmaRecord()],
    });
    await expect(
      wrong.client.rma.process({ rmaNumber: EXISTING_RMA_NUMBER }),
    ).rejects.toBeInstanceOf(IndeterminateServiceWriteError);
    const timeout = setup(
      "ca",
      [
        {
          method: "POST",
          pathPattern: paths.rmaUpdate,
          reply: () => ({ status: 504, body: "gateway" }),
        },
      ],
      { rmas: [rmaRecord()] },
    );
    const err = await timeout.client.rma
      .process({ rmaNumber: EXISTING_RMA_NUMBER })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndeterminateServiceWriteError);
    expect((err as IndeterminateServiceWriteError).rmaNumber).toBe(EXISTING_RMA_NUMBER);
    expect(posts(timeout.calls)).toHaveLength(1);
  });
});

/** Awaits a call that must fail validation and returns its issues as one string. */
async function issuesOf(call: Promise<unknown>): Promise<string> {
  const err = await call.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NeweggValidationError);
  return (err as NeweggValidationError).issues.map((i) => `${i.path}: ${i.message}`).join("\n");
}

describe("rma.reject", () => {
  const rejectInput = {
    rmaNumber: EXISTING_RMA_NUMBER,
    reason: "physicalDamage" as const,
    carrier: "other" as const,
    otherCarrier: "Purolator",
    shipService: "Ground",
    trackingNumbers: ["TRACK0001"],
  };

  it("POSTs RejectRMARequest with the sample nesting", async () => {
    const { client, calls } = setup("ca", [updateOk("RejectRMAResponse")], { rmas: [rmaRecord()] });
    const preview = await client.rma.previewReject(rejectInput);
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings.join("\n")).toContain("denies the customer");
    await client.rma.reject({ ...rejectInput, trackingNumbers: ["T1", "T2"] });
    expect(posts(calls)[0]!.bodyJson).toEqual({
      OperationType: "RejectRMARequest",
      RequestBody: {
        RejectRMAInfo: {
          RMANumber: EXISTING_RMA_NUMBER,
          RejectReason: "3",
          ShipCarrier: "5",
          OtherShipCarrier: "Purolator",
          ShipService: "Ground",
          TrackingNumberList: { TrackingNumber: ["T1", "T2"] },
        },
      },
    });
  });

  it("applies the per-marketplace reason sets and the evidence rule", async () => {
    const ca = setup("ca", []);
    // 13-15 are Newegg.com / Neweggbusiness.com only; 16-18 are Newegg.ca only.
    expect(
      await issuesOf(ca.client.rma.previewReject({ ...rejectInput, reason: "unlockedCellphone" })),
    ).toContain("not available on the ca marketplace");
    const us = setup("us", []);
    expect(
      await issuesOf(us.client.rma.previewReject({ ...rejectInput, reason: "customerRequest" })),
    ).toContain("not available on the us marketplace");
    // Reason 4 needs a memo and images.
    const evidence = await issuesOf(
      ca.client.rma.previewReject({ ...rejectInput, reason: "itemMissing" }),
    );
    expect(evidence).toContain("memo: is required");
    expect(evidence).toContain("imageUrls");
    const ok = setup("ca", [updateOk("RejectRMAResponse")], { rmas: [rmaRecord()] });
    await ok.client.rma.reject({ ...rejectInput, reason: "customerRequest" });
    expect(
      (posts(ok.calls)[0]!.bodyJson as { RequestBody: { RejectRMAInfo: { RejectReason: string } } })
        .RequestBody.RejectRMAInfo.RejectReason,
    ).toBe("16");
  });

  it("requires the other-carrier name only for carrier other", async () => {
    const { client } = setup("ca", [], { rmas: [rmaRecord()] });
    const { otherCarrier: _omit, ...withoutName } = rejectInput;
    expect(await issuesOf(client.rma.previewReject(withoutName))).toContain("otherCarrier");
    expect(await issuesOf(client.rma.previewReject({ ...rejectInput, carrier: "ups" }))).toContain(
      "otherCarrier",
    );
  });
});
