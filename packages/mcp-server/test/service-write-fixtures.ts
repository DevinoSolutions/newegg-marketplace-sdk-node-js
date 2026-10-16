import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";

/**
 * Synthetic fixtures for the RMA / courtesy-refund write tool tests (contracts §20). Everything
 * here is a fictional placeholder; the customer fields exist only so the tests can prove they are
 * never surfaced. The order is worth 110.00: 2 x 50.00 of SKU-PLACEHOLDER plus 10.00 shipping.
 */
export const ORDER_NUMBER = "900000002";
export const SKU = "SKU-PLACEHOLDER";
export const RMA_NUMBER = "900000011";
export const NEW_RMA_NUMBER = "900000010";
export const REQUEST_ID = "00000000-0000-4000-8000-000000000099";
export const CUSTOMER_SENTINEL = "CUSTOMER-NAME-SENTINEL";
export const TRACKING_SENTINEL = "TRACKING-SENTINEL-0001";

type Json = Record<string, unknown>;

export function orderBody(overrides: Json = {}): unknown {
  return {
    IsSuccess: true,
    ResponseBody: {
      PageInfo: { TotalCount: 1, TotalPageCount: 1, PageIndex: 1, PageSize: 100 },
      OrderInfoList: [
        {
          OrderNumber: ORDER_NUMBER,
          InvoiceNumber: "900000003",
          OrderStatus: 2,
          SalesChannel: 0,
          FulfillmentOption: 0,
          CurrencyCode: "CAD",
          CustomerName: CUSTOMER_SENTINEL,
          ShippingAmount: "10.00",
          RefundAmount: "0.00",
          OrderTotalAmount: "110.00",
          ItemInfoList: [
            {
              SellerPartNumber: SKU,
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

export function rmaRecord(overrides: Json = {}): Json {
  return {
    RMANumber: RMA_NUMBER,
    RMAType: "2",
    RMAStatus: "1",
    OrderNumber: ORDER_NUMBER,
    CustomerName: CUSTOMER_SENTINEL,
    RMANote: "NOTE-SENTINEL",
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

export interface Reads {
  order?: unknown;
  rmas?: Json[];
  courtesyRefunds?: Json[];
}

export function readRoutes(reads: Reads = {}): MockRoute[] {
  const courtesy = reads.courtesyRefunds ?? [];
  return [
    {
      method: "PUT",
      pathPattern: /ordermgmt\/order\/orderinfo\?/,
      reply: () => ({ status: 200, body: reads.order ?? orderBody() }),
    },
    {
      method: "PUT",
      pathPattern: /servicemgmt\/rma\/rmainfo\?/,
      reply: () => {
        // Read lazily: a test may change the RMAs between preview and apply.
        const rmas = reads.rmas ?? [];
        return {
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
        };
      },
    },
    {
      method: "PUT",
      pathPattern: /servicemgmt\/courtesyrefund\/info\?/,
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

export function rmaWriteBody(operationType: string, overrides: Json = {}): unknown {
  return {
    IsSuccess: "true",
    OperationType: operationType,
    SellerID: "A006",
    ResponseBody: {
      RMAInfo: {
        RMANumber: RMA_NUMBER,
        RMAType: "2",
        RMAStatus: "6",
        RMAStatusDescription: "Processing",
        OrderNumber: ORDER_NUMBER,
        SellerRMANumber: "SELLERRMA1",
        CustomerName: CUSTOMER_SENTINEL,
        RMANote: "NOTE-SENTINEL",
        ReturnShippingLabel: { Label: { TrackingNumber: TRACKING_SENTINEL } },
        RMATransactionList: {
          RMATransaction: {
            SellerPartNumber: SKU,
            ReturnQuantity: "1",
            ReturnUnitPrice: "40.00",
            RefundShippingPrice: "0.00",
            RMAReason: "2",
            Memo: "MEMO-SENTINEL",
          },
        },
        ...overrides,
      },
    },
  };
}

export const courtesyIssueBody = {
  IsSuccess: "true",
  OperationType: "CourtesyRefundResponse",
  SellerID: "A006",
  ResponseBody: {
    ResponseList: {
      ResponseInfo: {
        RequestId: REQUEST_ID,
        RequestDate: "2026-10-15 09:00:00",
        RequestStatus: "SUBMITTED",
      },
    },
  },
};
