import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { callTool, startHarness } from "./helpers.js";

const ORDER_INFO_BODY = {
  IsSuccess: true,
  OperationType: "GetOrderInfoResponse",
  SellerID: "A006",
  ResponseBody: {
    PageInfo: { TotalCount: 1, TotalPageCount: 1, PageIndex: 1, PageSize: 100 },
    OrderInfoList: [
      {
        OrderNumber: 511952652,
        OrderStatus: 2,
        OrderStatusDescription: "Shipped",
        CustomerName: "Test Buyer",
        CustomerEmailAddress: "cusa.x@marketplace.newegg.com",
        ShipToStateCode: "CA",
        CurrencyCode: "USD",
        OrderTotalAmount: 19.99,
        FulfillmentOption: 0,
        SalesChannel: 0,
        ItemInfoList: [{ SellerPartNumber: "SKU-1", Status: 2, OrderedQty: 1 }],
        PackageInfoList: [{ TrackingNumber: "1Z999", ShipCarrier: "UPS" }],
      },
    ],
  },
};

const ORDER_STATUS_BODY = {
  OrderNumber: "511952652",
  OrderStatusCode: 2,
  OrderStatusName: "Shipped",
  SellerID: "A006",
  OrderDownloaded: true,
  SalesChannel: 0,
  FulfillmentOption: 0,
};

function orderInfoRoute(body: unknown): MockRoute {
  return {
    method: "PUT",
    pathPattern: /ordermgmt\/order\/orderinfo/,
    reply: () => ({ status: 200, body }),
  };
}
function orderStatusRoute(body: unknown, status = 200): MockRoute {
  return {
    method: "GET",
    pathPattern: /ordermgmt\/orderstatus\/orders\//,
    reply: () => ({ status, body }),
  };
}

interface OutOrder {
  orderNumber: string;
  status: string;
  currencyCode?: string;
  customer?: { emailAddress?: string; shipTo?: { stateCode?: string } };
  items: Array<{ sellerPartNumber?: string; status: string }>;
  packages: Array<{ trackingNumber?: string }>;
}

describe("newegg_orders_list", () => {
  it("returns normalized orders and forwards criteria to the order-info endpoint", async () => {
    const harness = await startHarness({ routes: [orderInfoRoute(ORDER_INFO_BODY)] });
    try {
      const res = await callTool(harness.mcp, "newegg_orders_list", {
        status: "shipped",
        pageSize: 10,
      });
      expect(res.isError).toBe(false);
      expect(res.json.totalCount).toBe(1);
      const orders = res.json.orders as OutOrder[];
      expect(orders).toHaveLength(1);
      expect(orders[0]!.orderNumber).toBe("511952652");
      expect(orders[0]!.status).toBe("shipped");
      expect(orders[0]!.currencyCode).toBe("USD");
      expect(orders[0]!.customer?.shipTo?.stateCode).toBe("CA");
      expect(orders[0]!.items[0]!.sellerPartNumber).toBe("SKU-1");
      expect(orders[0]!.items[0]!.status).toBe("shipped");
      expect(orders[0]!.packages[0]!.trackingNumber).toBe("1Z999");

      // Request went to the CA order-info endpoint with the mapped Status code and page size.
      expect(harness.calls[0]!.url.pathname).toContain("/can/ordermgmt/order/orderinfo");
      const reqBody = harness.calls[0]!.bodyJson as {
        RequestBody: { PageSize: number; RequestCriteria: { Status?: number } };
      };
      expect(reqBody.RequestBody.PageSize).toBe(10);
      expect(reqBody.RequestBody.RequestCriteria.Status).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("converts an ISO dateFrom to a Pacific wall-clock criterion", async () => {
    const harness = await startHarness({ routes: [orderInfoRoute(ORDER_INFO_BODY)] });
    try {
      // 20:30:00Z on 2023-06-15 is 13:30:00 Pacific (PDT).
      await callTool(harness.mcp, "newegg_orders_list", { dateFrom: "2023-06-15T20:30:00.000Z" });
      const reqBody = harness.calls[0]!.bodyJson as {
        RequestBody: { RequestCriteria: { OrderDateFrom?: string } };
      };
      expect(reqBody.RequestBody.RequestCriteria.OrderDateFrom).toBe("2023-06-15 13:30:00");
    } finally {
      await harness.close();
    }
  });

  it("rejects unknown keys and out-of-range page sizes at the schema boundary", async () => {
    const harness = await startHarness({ routes: [orderInfoRoute(ORDER_INFO_BODY)] });
    try {
      const unknownKey = await callTool(harness.mcp, "newegg_orders_list", { bogus: true });
      expect(unknownKey.isError).toBe(true);
      const badPage = await callTool(harness.mcp, "newegg_orders_list", { pageSize: 999 });
      expect(badPage.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_orders_get", () => {
  it("returns found=true with the order detail", async () => {
    const harness = await startHarness({ routes: [orderInfoRoute(ORDER_INFO_BODY)] });
    try {
      const res = await callTool(harness.mcp, "newegg_orders_get", { orderNumber: 511952652 });
      expect(res.isError).toBe(false);
      expect(res.json.found).toBe(true);
      expect((res.json.order as OutOrder).orderNumber).toBe("511952652");
    } finally {
      await harness.close();
    }
  });

  it("returns found=false when Newegg has no such order", async () => {
    const empty = { ResponseBody: { PageInfo: { TotalCount: 0 }, OrderInfoList: [] } };
    const harness = await startHarness({ routes: [orderInfoRoute(empty)] });
    try {
      const res = await callTool(harness.mcp, "newegg_orders_get", { orderNumber: 1 });
      expect(res.isError).toBe(false);
      expect(res.json.found).toBe(false);
      expect(res.json.order).toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_orders_get_status", () => {
  it("returns found=true with the normalized status", async () => {
    const harness = await startHarness({ routes: [orderStatusRoute(ORDER_STATUS_BODY)] });
    try {
      const res = await callTool(harness.mcp, "newegg_orders_get_status", {
        orderNumber: 511952652,
      });
      expect(res.isError).toBe(false);
      expect(res.json.found).toBe(true);
      const status = res.json.orderStatus as { status: string; statusName?: string };
      expect(status.status).toBe("shipped");
      expect(status.statusName).toBe("Shipped");
    } finally {
      await harness.close();
    }
  });

  it("maps SO003 to found=false rather than an error", async () => {
    const so003 = [
      { Code: "SO003", Message: "No data found or this order does not belong to this seller" },
    ];
    const harness = await startHarness({ routes: [orderStatusRoute(so003, 400)] });
    try {
      const res = await callTool(harness.mcp, "newegg_orders_get_status", { orderNumber: 1 });
      expect(res.isError).toBe(false);
      expect(res.json.found).toBe(false);
      expect(res.json.orderStatus).toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});
