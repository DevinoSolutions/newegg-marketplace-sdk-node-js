import { describe, expect, it } from "vitest";
import { NeweggValidationError, UnsupportedMarketplaceOperationError } from "../src/index.js";
import { makeClient } from "./helpers.js";

/** Fictional placeholders only (the repo is public). Shape follows contracts §24. */
const RESPONSE = {
  IsSuccess: "true",
  SellerID: "A006",
  OperationType: "GetAddOrderInfoResponse",
  ResponseBody: {
    PageInfo: { TotalCount: 1, TotalPageCount: 1, PageSize: 100, PageIndex: 1 },
    AddOrderInfoList: {
      AddOrderInfo: {
        OrderNumber: 123456789,
        RecipientIDType: "CPF",
        RecipientIDNumber: "000.000.000-00",
        NISPOriginalInfo: { NISPOriFirstName: "Ana", NISPOriCountryCode: "BRA" },
        OriginalInputInfo: { OriginalFirstName: "Ana", OriginalCity: "Sao Paulo" },
        AddInfo1: "",
        TaxDutyTypeChina: "DDU",
        ImportTypeChina: "EE",
        IDCopyFront: "https://example.invalid/front.jpg",
      },
    },
  },
  Memo: "",
  ResponseDate: "09/01/2018 16:51:03",
};

const route = (body: unknown = RESPONSE) => [
  {
    method: "POST",
    pathPattern: /ordermgmt\/order\/addorderinfo/,
    reply: () => ({ status: 200, body }),
  },
];

describe("orders additional info (us)", () => {
  it("POSTs the lowercase path and normalizes the record", async () => {
    const t = makeClient("us", route());
    const page = await t.client.orders.listAdditionalInfo({
      orderNumbers: [123456789],
      status: "shipped",
      type: "nisp",
      includeDownloaded: false,
      countryCode: "BRA",
    });
    const call = t.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url.pathname).toBe("/marketplace/ordermgmt/order/addorderinfo");
    expect(call?.bodyJson).toEqual({
      OperationType: "GetAddOrderInfoRequest",
      RequestBody: {
        PageIndex: 1,
        PageSize: 100,
        RequestCriteria: {
          OrderNumberList: { OrderNumber: ["123456789"] },
          Status: 2,
          Type: 3,
          OrderDownloaded: 1,
          CountryCode: "BRA",
        },
      },
    });
    expect(page.totalCount).toBe(1);
    const rec = page.records[0];
    expect(rec?.orderNumber).toBe("123456789");
    expect(rec?.recipientIdType).toBe("CPF");
    expect(rec?.nispOriginal?.firstName).toBe("Ana");
    expect(rec?.nispOriginal?.countryCode).toBe("BRA");
    expect(rec?.originalInput?.city).toBe("Sao Paulo");
    expect(rec?.taxDutyTypeChina).toBe("DDU");
    expect(rec?.reserved).toEqual([]);
  });

  it("accepts an array list and flat prefixed fields", async () => {
    const t = makeClient(
      "us",
      route({
        ResponseBody: {
          AddOrderInfoList: [{ OrderNumber: "5", NISPOriCity: "X", OriginalCity: "Y" }],
        },
      }),
    );
    const rec = await t.client.orders.getAdditionalInfo(5);
    expect(rec.nispOriginal?.city).toBe("X");
    expect(rec.originalInput?.city).toBe("Y");
  });

  it("tryGetAdditionalInfo resolves undefined for an empty list; get throws", async () => {
    const empty = { ResponseBody: { PageInfo: { TotalCount: 0 } } };
    const t = makeClient("us", route(empty));
    await expect(t.client.orders.tryGetAdditionalInfo(1)).resolves.toBeUndefined();
    await expect(t.client.orders.getAdditionalInfo(1)).rejects.toThrow();
  });

  it("validates paging", async () => {
    const t = makeClient("us", route());
    await expect(t.client.orders.listAdditionalInfo({ pageSize: 0 })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
  });
});

describe("orders additional info (b2b / ca)", () => {
  it.each(["b2b", "ca"] as const)("%s fails before sending", async (marketplace) => {
    const t = makeClient(marketplace, route());
    await expect(t.client.orders.listAdditionalInfo()).rejects.toBeInstanceOf(
      UnsupportedMarketplaceOperationError,
    );
    expect(t.calls).toHaveLength(0);
  });
});
