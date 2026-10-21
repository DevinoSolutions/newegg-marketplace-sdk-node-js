import type { MockRoute } from "../src/testing/index.js";
import { paths } from "./helpers.js";

/**
 * Synthetic fixtures for the RMA / courtesy-refund WRITE tests (contracts §20). Every identifier,
 * amount and part number is a fictional placeholder: the repo is public and these tests never
 * touch a real account. The order is worth 110.00: 2 x 50.00 of SKU-PLACEHOLDER plus 10.00 shipping.
 * The order carries no `CurrencyCode`: these fixtures are shared by us/b2b/ca tests, and the orders
 * currency guard (T-5911) rejects a page whose every order is in the wrong marketplace's currency.
 */
export const ORDER_NUMBER = "900000002";
export const SKU = "SKU-PLACEHOLDER";
export const NEW_RMA_NUMBER = "900000010";
export const EXISTING_RMA_NUMBER = "900000011";
export const REQUEST_ID = "00000000-0000-4000-8000-000000000099";

type Json = Record<string, unknown>;

/** Get Order Information response for one shipped order (override any order field). */
export function orderResponse(overrides: Json = {}): unknown {
  return {
    IsSuccess: true,
    OperationType: "GetOrderInfoResponse",
    SellerID: "A006",
    ResponseBody: {
      PageInfo: { TotalCount: 1, TotalPageCount: 1, PageIndex: 1, PageSize: 100 },
      OrderInfoList: [
        {
          SellerID: "A006",
          OrderNumber: ORDER_NUMBER,
          InvoiceNumber: "900000003",
          OrderStatus: 2,
          OrderStatusDescription: "Shipped",
          SalesChannel: 0,
          FulfillmentOption: 0,
          ShippingAmount: "10.00",
          RefundAmount: "0.00",
          OrderTotalAmount: "110.00",
          OrderQty: 2,
          ItemInfoList: [
            {
              SellerPartNumber: SKU,
              NeweggItemNumber: "9SIA0000000000",
              OrderedQty: 2,
              ShippedQty: 2,
              UnitPrice: "50.00",
              Status: 2,
            },
          ],
          ...overrides,
        },
      ],
    },
  };
}

const EMPTY_ORDER_PAGE = {
  IsSuccess: true,
  ResponseBody: { PageInfo: { TotalCount: 0, TotalPageCount: 0, PageIndex: 1, PageSize: 100 } },
};

/** One RMA as Get RMA Information returns it. */
export function rmaRecord(overrides: Json = {}): Json {
  return {
    RMANumber: EXISTING_RMA_NUMBER,
    RMAType: "2",
    RMAStatus: "1",
    RMAStatusDescription: "Open",
    OrderNumber: ORDER_NUMBER,
    RMATransactionList: {
      RMATransaction: {
        SellerPartNumber: SKU,
        UnitPrice: "50.00",
        ReturnQuantity: "1",
        ReturnUnitPrice: "50.00",
        RefundShippingPrice: "0.00",
        RMAReason: "2",
      },
    },
    ...overrides,
  };
}

/** One courtesy refund as Get Courtesy Refund Information returns it. */
export function courtesyRecord(overrides: Json = {}): Json {
  return {
    CourtesyRefundID: "00000000-0000-4000-8000-000000000001",
    SONumber: ORDER_NUMBER,
    RefundAmount: "10.00",
    ReasonCode: "6",
    Status: "Open",
    ...overrides,
  };
}

export interface ReadFixtures {
  /** The order, or `null` for "no such order"; defaults to the 110.00 shipped order. */
  order?: unknown;
  rmas?: Json[];
  courtesyRefunds?: Json[];
}

/** The three READ routes every preview and write consults. */
export function readRoutes(fixtures: ReadFixtures = {}): MockRoute[] {
  const rmas = fixtures.rmas ?? [];
  const courtesy = fixtures.courtesyRefunds ?? [];
  return [
    {
      method: "PUT",
      pathPattern: paths.orderInfo,
      reply: () => ({
        status: 200,
        body: fixtures.order === null ? EMPTY_ORDER_PAGE : (fixtures.order ?? orderResponse()),
      }),
    },
    {
      method: "PUT",
      pathPattern: paths.rmaInfo,
      // Lookups by RMA number and by order number are both served from `rmas`.
      reply: () => ({
        status: 200,
        body: {
          IsSuccess: "true",
          ResponseBody: {
            PageInfo: {
              TotalCount: String(rmas.length),
              TotalPageCount: "1",
              PageIndex: "1",
              PageSize: "100",
            },
            RMAInfoList: rmas.length === 0 ? "" : { RMAInfo: rmas },
          },
        },
      }),
    },
    {
      method: "PUT",
      pathPattern: paths.courtesyRefundInfo,
      reply: () => ({
        status: 200,
        body: {
          IsSuccess: "true",
          ResponseBody: {
            PageInfo: {
              TotalCount: String(courtesy.length),
              TotalPageCount: "1",
              PageIndex: "1",
              PageSize: "100",
            },
            CourtesyRefundInfoList: courtesy.length === 0 ? "" : { CourtesyrefundInfo: courtesy },
          },
        },
      }),
    },
  ];
}

/** An RMA write response (Edit / Process / Reject / Submit samples: `ResponseBody > RMAInfo`). */
export function rmaWriteResponse(
  overrides: Json = {},
  operationType = "IssueRMAResponse",
): unknown {
  return {
    IsSuccess: "true",
    OperationType: operationType,
    SellerID: "A006",
    ResponseDate: "10/15/2026 09:00:00",
    ResponseBody: {
      RMAInfo: {
        RMANumber: NEW_RMA_NUMBER,
        RMAType: "2",
        RMATypeDescription: "Refund",
        SourceSONumber: ORDER_NUMBER,
        OrderNumber: ORDER_NUMBER,
        SellerRMANumber: "SELLERRMA1",
        RMAStatus: "6",
        RMAStatusDescription: "Processing",
        RMANote: "note",
        RMATransactionList: {
          RMATransaction: {
            SellerPartNumber: SKU,
            ReturnQuantity: "1",
            ReturnUnitPrice: "40.00",
            RefundShippingPrice: "0.00",
            RMAReason: "2",
            RMAReasonDescription: "Defective",
          },
        },
        ...overrides,
      },
    },
  };
}

/** The Issue Courtesy Refund response (JSON sample shape). */
export function courtesyIssueResponse(info: Json = {}): unknown {
  return {
    IsSuccess: "true",
    OperationType: "CourtesyRefundResponse",
    SellerID: "A006",
    ResponseBody: {
      ResponseList: {
        ResponseInfo: {
          RequestId: REQUEST_ID,
          RequestDate: "2026-10-15 09:00:00",
          RequestStatus: "SUBMITTED",
          ...info,
        },
      },
    },
  };
}
