# Newegg Marketplace API — Verified Wire Contracts

> Extracted 2026-07-10 from the official Newegg Developer Portal
> (https://developer.newegg.com/newegg_marketplace_api/). Every endpoint, method and
> body below was verified against the official sample requests/responses on the pages
> cited. Items marked **ASSUMPTION** were not fully specified by the documentation and
> are isolated behind named adapters in the SDK (see `docs/platform-differences.md`).

## 1. Authentication (all platforms)

| Concern    | Value                                                                     |
| ---------- | ------------------------------------------------------------------------- |
| API key    | `Authorization: {apiKey}` request header (raw value, no scheme prefix)    |
| Secret key | `SecretKey: {secretKey}` request header                                   |
| Seller     | `?sellerid={SellerID}` query parameter (value may keep its original case) |
| Media type | `Content-Type: application/json` + `Accept: application/json`             |
| Transport  | HTTPS only                                                                |

Auth error bodies (JSON **array**):
`[{"Code":"InvalidConsumerKey","Message":"The provided consumer key is malformed or otherwise invalid."}]`,
`[{"Code":"InvalidToken","Message":"Invalid secret key."}]`.
The API gateway may also answer `401` with the **plain-text** body `Gateway: Seller Auth failed.`
(observed live 2026-07-10) — error parsing must tolerate non-JSON bodies.

Other observed error shapes:

- Single JSON object: `{"Code":"CT002","Message":"Invalid SellerPartNumber"}`
- JSON array: `[{"Code":"CE001","Message":"SellerID cannot be null or empty"}]`
- XML: `<?xml version="1.0"?>...<Code>DF006</Code>...` (returned when `Accept` handling falls back)

## 2. Base URLs and general rules

| Platform                   | Prefix                                    |
| -------------------------- | ----------------------------------------- |
| Newegg.com (`us`)          | `https://api.newegg.com/marketplace/`     |
| Neweggbusiness.com (`b2b`) | `https://api.newegg.com/marketplace/b2b/` |
| Newegg.ca (`ca`)           | `https://api.newegg.com/marketplace/can/` |

- Endpoints are **case-sensitive**; the whole URL must be lowercase **except the Seller ID value**.
- No blank spaces / line breaks in URLs.
- **All datetime fields are Pacific Time** (docs say "Pacific Standard Time") in requests
  and responses, e.g. `2/22/2012 17:24:35`. Response timestamps sometimes carry an
  explicit offset (`2022-04-20T23:46:41.7786361-07:00`).
- API credentials are **platform-specific**: a US key is not valid on `/b2b/` or `/can/`.

## 3. Throttling

- Rate limiting is **per seller**, per API function, in one-minute windows.
- Data-feed functions add hourly request limits and per-request size limits.
- On exceeding a limit: HTTP **429** with body `[{"Code":"429","Message":"Too many request."}]`.
- Data-feed hourly-allowance error (code **DF012**):
  `[{"Code":"DF012","Message":"Your feed with request ID: 2291326430 exceeded the hourly allowance and cannot be processed. Please submit your feed again after 2016-12-16 11:05:00."}]`
  (timestamp is Pacific Time).
- Diagnostic response headers (all confirmed on the throttling page):
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-ResetTime`,
  `X-RecordCount-Limit`, `X-RecordCount-Remaining`, `X-RecordCount-ResetTime`.

## 4. Item identifier `Type` codes

`0` = Newegg Item Number, `1` = Seller Part Number, `2` = UPC. Verified in every official
sample (`"Type": "1"` always paired with a seller part number value). `Condition` applies
when the identifier is UPC.

**ASSUMPTION (condition codes)**: `1`=New, `2`=Refurbished, `3`=Used-Like New,
`4`=Used-Very Good, `5`=Used-Good, `6`=Used-Acceptable. The docs' condition table did not
render in extraction; the mapping matches Newegg's item-condition codes used across the
Item Management APIs (batch read sample returns `"Condition": 1` for a new item). Isolated
in `packages/sdk/src/schemas/condition.ts`.

## 5. Inventory reads

### 5.1 US single item — Get Inventory (International)

```
PUT https://api.newegg.com/marketplace/contentmgmt/item/international/inventory?sellerid={SellerID}
```

Request:

```json
{
  "Type": "1",
  "Value": "A006testitem201201021459",
  "WarehouseList": { "WarehouseLocation": ["USA", "AUS"] }
}
```

Response (note: numbers as strings):

```json
{
  "SellerID": "A006",
  "ItemNumber": "9SIA0060884598",
  "SellerPartNumber": "...",
  "InventoryAllocation": {
    "Inventory": [
      { "WarehouseLocation": "USA", "FulfillmentOption": "0", "AvailableQuantity": "107" },
      {
        "WarehouseLocation": "USA",
        "FulfillmentOption": "1",
        "AvailableQuantity": "40",
        "WarehouseAllocation": { "Warehouse": [{ "WarehouseCode": "07", "Quantity": "3" }] }
      }
    ]
  }
}
```

`FulfillmentOption`: `"0"` = shipped by seller, `"1"` = shipped by Newegg (SBN); SBN
entries break down per Newegg `WarehouseCode`.

### 5.2 B2B / CAN single item — Get Item Inventory

```
POST https://api.newegg.com/marketplace/b2b/contentmgmt/item/inventory?sellerid={SellerID}&version=304
POST https://api.newegg.com/marketplace/can/contentmgmt/item/inventory?sellerid={SellerID}&version=304
```

Request: `{ "Type": "1", "Value": "A006testitem201201021459" }`

Response (**mixed types on the wire** — `AvailableQuantity` observed both as number `71`
and string `"50"`):

```json
{
  "Active": "0",
  "ItemNumber": "9SIA0060884598",
  "SellerID": "A006",
  "SellerPartNumber": "...",
  "FulfillmentOption": "1",
  "AvailableQuantity": 71,
  "WarehouseAllocation": { "Warehouse": [{ "WarehouseCode": "35", "Quantity": "3" }] }
}
```

The XML sample also shows `WarehouseCode` `"SBS"` (shipped-by-seller bucket) inside
`WarehouseAllocation`. The `version=304` query parameter is part of the documented URL.

**Verified live (CA, 2026-07-17) — identifier resolution:** `Type: "0"` (Newegg item number)
resolves the SELLER's offer numbers (`9SI…` form) only. The catalog's product-form numbers
(`20-xxx-xxx`, as returned by the Item Lookup Report §12) return CT026 "item does not exist in
your account" whether or not the seller has an offer on that product — they are NOT valid
inventory identifiers. To check "do I already list this product?", read by `Type: "2"` (UPC)
or `Type: "1"` (seller part number). Not-found error codes differ by identifier type
(verified live, 2026-07-18): SKU/item-number reads fail CT026, while UPC reads for a product
the seller has no offer on fail **CT010** (9/9 observed; CT010 also covers malformed UPC
values — the two are indistinguishable on the wire). Also: while an item is deactivated,
reads report `AvailableQuantity` 0, which may mask the stored quantity.

### 5.3 US batch — Get Batch Inventory (International)

```
POST https://api.newegg.com/marketplace/contentmgmt/item/international/inventorylist?sellerid={SellerID}
```

Request: `{ "Type": "1", "Values": ["SKU-1","SKU-2"], "WarehouseList": ["USA","AUS"] }`
(`WarehouseList` here is a plain string array — different from the single-item read.)

Response envelope:

```json
{
  "ResponseBody": {
    "ItemList": [
      {
        "ItemNumber": "...",
        "SellerPartNumber": "...",
        "Condition": 1,
        "InventoryAllocation": [
          { "WarehouseLocation": "USA", "FulfillmentOption": "0", "AvailableQuantity": 10 }
        ]
      }
    ],
    "TotalCount": 3
  },
  "IsSuccess": true,
  "OperationType": "GetInventoryList",
  "SellerID": "A006",
  "ResponseDate": "2022-04-20T23:46:41.7786361-07:00"
}
```

**ASSUMPTION (batch size)**: the documented per-request maximum for `Values` did not
render in extraction; the SDK chunks batch reads at **100** identifiers per request
(constant `GET_BATCH_INVENTORY_MAX_VALUES`, documented and configurable).

### 5.4 B2B / CAN batch — Get Batch Inventory

```
POST https://api.newegg.com/marketplace/b2b/contentmgmt/item/inventorylist?sellerid={SellerID}
POST https://api.newegg.com/marketplace/can/contentmgmt/item/inventorylist?sellerid={SellerID}
```

Request: `{ "Type": "1", "Values": ["SKU-1","SKU-2"] }` (no `WarehouseList`, no `version` param)

Response: same envelope; items are flat:
`{ "ItemNumber", "SellerPartNumber", "FulfillmentOption": "0"|"1", "Active": "0"|"1",
"AvailableQuantity": 10, "WarehouseAllocation"?: [ { "WarehouseCode", "Quantity" } ] }`.

## 6. Inventory writes (direct)

### 6.1 US — Update Item Inventory (International)

```
POST https://api.newegg.com/marketplace/contentmgmt/item/international/inventory?sellerid={SellerID}
```

Request (numbers serialized as strings, matching official sample):

```json
{
  "Type": "1",
  "Value": "A006BSP3",
  "InventoryList": {
    "Inventory": [
      { "WarehouseLocation": "USA", "AvailableQuantity": "107" },
      { "WarehouseLocation": "AUS", "AvailableQuantity": "0" }
    ]
  }
}
```

Response: `{ "SellerID", "ItemNumber", "SellerPartNumber", "InventoryList": { "Inventory": [...] } }`
(XML root `<UpdateInventoryResult>`). Limit: 10,000 requests/hour.
`WarehouseLocation` is an ISO 3166-1 alpha-3 country code (e.g. `USA`, `AUS`).
Same URL as the single-item read — **method selects the operation** (PUT=read, POST=write).

### 6.2 B2B / CAN — Update Inventory and Price (inventory-only use)

```
PUT https://api.newegg.com/marketplace/b2b/contentmgmt/item/inventoryandprice?sellerid={SellerID}
PUT https://api.newegg.com/marketplace/can/contentmgmt/item/inventoryandprice?sellerid={SellerID}
```

Official full sample body includes price fields; **the SDK sends the inventory-only
subset**: `{ "Type": "1", "Value": "A006BSP3", "Inventory": "20" }`. No `Active`,
no price fields, no `FulfillmentOption` are ever sent by the inventory API
(sending `Active` can activate/deactivate a listing; `null`/omitted = no change per docs).

Response: `{ "UpdateInventoryAndPriceResult": { "SellerID", "ItemNumber",
"SellerPartNumber", "FulfillmentOption", "Active", "Result", "AvailableQuantity",
"MAP", "CheckoutMAP", "SellingPrice", "EnableFreeShipping", "LimitQuantity" } }` (all strings).

Platform notes (verbatim from docs):

- "Once an item has been deactivated, all price and inventory update requests shall be disregarded."
  **Verified live (CA, 2026-07-17): this is a FALSE SUCCESS** — the update on a deactivated item
  is HTTP-accepted and the per-item `Result` reads succeeded, but the stored quantity does not
  change. Do not trust a "succeeded" outcome unless the item reads `Active`. (The ITEM_DATA v2
  feed, §13, DOES persist fields on deactivated items.)
- "You're not able to update the inventory for a SBN (Shipped by Newegg) item."
- Default-warehouse semantics: B2B/CAN direct updates apply to the platform's default
  warehouse; there is no `WarehouseLocation` in the request.

## 7. Data feeds

### 7.1 US — Inventory Update Feed

```
POST https://api.newegg.com/marketplace/datafeedmgmt/feeds/submitfeed?sellerid={sellerid}&requesttype=INVENTORY_DATA
```

```json
{
  "NeweggEnvelope": {
    "Header": { "DocumentVersion": "2.0" },
    "MessageType": "Inventory",
    "Message": {
      "Inventory": {
        "Item": [
          {
            "SellerPartNumber": "a006-test-001",
            "NeweggItemNumber": "9SIAWE50008504",
            "WarehouseLocation": "USA",
            "FulfillmentOption": "Seller",
            "Inventory": "200"
          }
        ]
      }
    }
  }
}
```

`SellerPartNumber` required; `NeweggItemNumber` optional; one warehouse per region per
item ("only one warehouse per region"). `FulfillmentOption: "Seller"` (feeds cannot touch
SBN inventory). The official single-item sample nests `Item` as an object; the SDK always
serializes `Item` as an **array** (accepted single-or-array is an XML-to-JSON artifact;
responses require tolerant single-or-array parsing everywhere).

### 7.2 B2B / CAN — Inventory and Price Feed (inventory-only use)

```
POST https://api.newegg.com/marketplace/b2b/datafeedmgmt/feeds/submitfeed?sellerid={sellerid}&requesttype=INVENTORY_AND_PRICE_DATA
POST https://api.newegg.com/marketplace/can/datafeedmgmt/feeds/submitfeed?sellerid={sellerid}&requesttype=INVENTORY_AND_PRICE_DATA
```

```json
{
  "NeweggEnvelope": {
    "Header": { "DocumentVersion": "1.0" },
    "MessageType": "Inventory",
    "Overwrite": "No",
    "Message": {
      "Inventory": {
        "Item": [
          {
            "SellerPartNumber": "SKU-1",
            "Inventory": "159"
          }
        ]
      }
    }
  }
}
```

- **`DocumentVersion` is `1.0` here (US uses `2.0`).**
- `Overwrite` sits at the envelope level. Docs: _"Yes: Will have the added effect of
  deactivating all of your items from the website not listed on this datafeed."_ —
  the SDK **hard-codes `"No"`** and provides no way to set `"Yes"` through the inventory API.
- Optional per-item fields in the official sample (`SellingPrice`, `Shipping`,
  `ActivationMark`, `Currency`, `LimitQuantity`, `FulfillmentOption`, `NeweggItemNumber`)
  are **never emitted** by the inventory-only serializer except `NeweggItemNumber`.

### 7.3 Feed submit response (both platforms)

```json
{
  "IsSuccess": true,
  "OperationType": "SubmitFeedResponse",
  "ResponseBody": {
    "ResponseList": [
      {
        "RequestDate": "2/22/2012 17:24:35",
        "RequestId": "2PQCX3CMQ82MK",
        "RequestStatus": "SUBMITTED",
        "RequestType": "INVENTORY_DATA"
      }
    ]
  },
  "SellerID": "A006"
}
```

XML variant nests `ResponseList > ResponseInfo` — tolerant parsing required.
`RequestId` observed both alphanumeric (`2PQCX3CMQ82MK`) and numeric (`2291326430`).

### 7.4 Feed limits

- Max **10,000 records per feed file**; max **10 feed submissions per minute**;
  max **100,000 inventory records per hour** (feed error `DF003` mentions a 30,000
  `MaxCount` cap for status queries; `DF012` for the hourly allowance).

### 7.5 Get Feed Status

```
PUT https://api.newegg.com/marketplace/{prefix}datafeedmgmt/feeds/status?sellerid={sellerid}
```

```json
{
  "OperationType": "GetFeedStatusRequest",
  "RequestBody": {
    "GetRequestStatus": {
      "RequestIDList": { "RequestID": "2PQCX3SPZ3QBF" },
      "MaxCount": "100",
      "RequestStatus": "ALL"
    }
  }
}
```

`RequestID` accepts a single string or an array of strings. `RequestStatus` filter values:
`ALL | SUBMITTED | IN_PROGRESS | FINISHED | CANCELLED`. Response: same `ResponseList`
shape as 7.3 with per-request `RequestStatus`. Date-range filters exist in the docs but
their exact field names did not render in extraction — **date filters are intentionally
not implemented**; status is queried by request ID only (documented limitation).

### 7.6 Get Feed Result

```
GET https://api.newegg.com/marketplace/{prefix}datafeedmgmt/feeds/result/{Requestid}?sellerid={sellerid}
```

Response:

```json
{
  "NeweggEnvelope": {
    "Header": { "DocumentVersion": "1.0" },
    "MessageType": "ProcessingReport",
    "Message": {
      "ProcessingReport": {
        "OriginalMessageName": "APIAutoFile.xml",
        "StatusCode": "ProcessReport",
        "ProcessingSummary": { "ProcessedCount": "3", "SuccessCount": "1", "WithErrorCount": "2" },
        "Result": [
          {
            "AdditionalInfo": { "SellerPartNumber": "sellerparttest001", "...": "..." },
            "ErrorList": { "ErrorDescription": ["Error(s). Item not created.", "..."] }
          }
        ]
      }
    }
  }
}
```

Semantics: `ProcessingSummary` carries totals; `Result` entries detail records **with
errors/warnings** (`SuccessCount` = "total successfully processed records"). Successful
records generally do not get a `Result` entry — per-record success is inferred from the
summary. `Result` may be a single object or an array; `ErrorDescription` may be a single
string or an array. Error `DF006` = invalid RequestID.

## 8. Service status

```
GET https://api.newegg.com/marketplace/{prefix}{domain}/servicestatus?sellerid={SellerID}
```

`{domain}` ∈ `contentmgmt | ordermgmt | datafeedmgmt | servicemgmt | reportmgmt |
sellermgmt | sbnmgmt | shippingservice`.

Response: `{ "NeweggAPIResponse": { "IsSuccess": "true", "OperationType": "GetServiceStatus",
"SellerID": "A006", "ResponseBody": { "Status": "0"|"1", "Timestamp": "2/15/2012 2:50:38",
"Message"?: "..." } } }` — `Status` `"1"` = available, `"0"` = unavailable. Note the extra
`NeweggAPIResponse` wrapper (absent from some other JSON responses) and booleans as strings.

## 9. Live verification log (2026-07-10)

Read-only probes with the credentials provided in `.env` (marketplace `CA`):
`GET .../can/contentmgmt/servicestatus` and `POST .../can/contentmgmt/item/inventorylist`
both returned **HTTP 401 `Gateway: Seller Auth failed.`** — same result on US and B2B
prefixes. Endpoints and header format match the official docs; the credentials themselves
were not accepted on any platform at test time. No mutating call was attempted.

## 10. Order Management (reads)

> Extracted 2026-07-12 from the official Newegg Developer Portal order-management pages
> (sources cited per subsection). Only **read** operations are documented; the SDK's order
> surface is read-only (no ship / cancel / refund). The portal also exposes _Get Additional
> Order Information_ and mutating order calls — deliberately **not** contracted here yet.

Order datetimes follow the §2 rule (Pacific Time, no offset — e.g. `3/18/2023 1:04:16`).
Money fields are decimals in the order's `CurrencyCode` (USD unless stated) and, like every
number on this API, may arrive as a JSON number _or_ string. Any single-element list may be
an object instead of an array (§2) — every list below is subject to that quirk.

### 10.1 Get Order Information

Source: `https://developer.newegg.com/newegg_marketplace_api/order_management/get_order_information/` (2026-07-12).

```
PUT https://api.newegg.com/marketplace/ordermgmt/order/orderinfo?sellerid={SellerID}&version={version}
PUT https://api.newegg.com/marketplace/b2b/ordermgmt/order/orderinfo?sellerid={SellerID}&version={version}
PUT https://api.newegg.com/marketplace/can/ordermgmt/order/orderinfo?sellerid={SellerID}&version={version}
```

A **read via PUT** (classify by this doc, not the HTTP verb — cf. §2). Auth required; XML/JSON
in and out. Rate limit **1000 requests/hour** per seller. Documented `version` values:
`304, 305, 306, 307, 309, 310, 311, 312, 313, 314, 315` (**note: no 308**); newer versions add
fields (flagged below).

Request — `RequestCriteria` selects orders; every criterion is optional (omit to match all).
Types mirror the official sample (paging/enum values sent as strings, all accepted):

```json
{
  "OperationType": "GetOrderInfoRequest",
  "RequestBody": {
    "PageIndex": "1",
    "PageSize": "100",
    "RequestCriteria": {
      "OrderNumberList": { "OrderNumber": ["159243598", "41473642"] },
      "SellerOrderNumberList": { "SellerOrderNumber": ["SO159243598"] },
      "Status": "1",
      "Type": "0",
      "OrderDateFrom": "2011-01-01 09:30:47",
      "OrderDateTo": "2011-12-17 09:30:47",
      "OrderDownloaded": 0,
      "CountryCode": "USA",
      "PremierOrder": "1"
    }
  }
}
```

- `PageSize` max **100** (default 100); `PageIndex` default 1.
- `OrderNumberList.OrderNumber[]` — an **array wrapper**, not a scalar; when present, other
  criteria are ignored (direct lookup by order number). `SellerOrderNumberList` is the
  analogous wrapper for seller order numbers (SBN).
- Enum criteria: `Status` 0 Unshipped · 1 PartiallyShipped · 2 Shipped · 3 Invoiced · 4 Voided
  · 5 Payment Pending (v312+; blank = all). `Type` 0 All · 1 SBN (shipped by Newegg) · 2 SBS
  (shipped by seller) · 3 Multi-Channel · 4 NWS. `OrderDownloaded` 0 include downloaded
  (default) · 1 exclude already-downloaded. `PremierOrder` 0 All · 1 Premier only · 2 No
  Premier. `VoidSoon` (optional) 24 | 48 — orders auto-voiding within N hours.
- `OrderDateFrom`/`OrderDateTo`: Pacific-Time strings (§2).

Response — envelope + `ResponseBody.PageInfo` + `ResponseBody.OrderInfoList`; each order nests
`ItemInfoList` and `PackageInfoList`. XML wraps lists as `<OrderInfoList><OrderInfo>…`; JSON
uses bare arrays. Like §8, the JSON body may or may not carry the outer `NeweggAPIResponse`
wrapper — tolerate both.

```json
{
  "IsSuccess": true,
  "OperationType": "GetOrderInfoResponse",
  "SellerID": "A2EU",
  "ResponseDate": "01/05/2022 14:16:28",
  "ResponseBody": {
    "PageInfo": { "TotalCount": 1, "TotalPageCount": 1, "PageIndex": 1, "PageSize": 100 },
    "OrderInfoList": [
      {
        "SellerID": "A2EU",
        "OrderNumber": 511952652,
        "SellerOrderNumber": "2153930",
        "InvoiceNumber": 0,
        "OrderDownloaded": false,
        "OrderDate": "03/18/2023 1:04:16",
        "AutoVoidTime": "04/01/2023 1:12:39",
        "OrderStatus": 4,
        "OrderStatusDescription": "Voided",
        "CustomerName": "…",
        "CustomerPhoneNumber": "…",
        "CustomerEmailAddress": "cusa.***@marketplace.newegg.com",
        "OnTimeShipDueDate": "11/14/2021",
        "DeliverDueDate": "11/22/2021",
        "ShipToAddress1": "…",
        "ShipToAddress2": "…",
        "ShipToCityName": "…",
        "ShipToStateCode": "CA",
        "ShipToZipCode": "91748-1119",
        "ShipToCountryCode": "UNITED STATES",
        "ShipService": "Standard Shipping (5-7 business days)",
        "SignatureRequired": true,
        "ShipToFirstName": "…",
        "ShipToLastName": "…",
        "ShipToCompany": "…",
        "CurrencyCode": "USD",
        "OrderItemAmount": 1.0,
        "ShippingAmount": 0,
        "DiscountAmount": 0,
        "RefundAmount": 0,
        "OrderTotalAmount": 1.0,
        "OrderQty": 2,
        "IsAutoVoid": false,
        "SalesChannel": 0,
        "FulfillmentOption": 0,
        "ItemInfoList": [
          {
            "SellerPartNumber": "…",
            "NeweggItemNumber": "9SIA2EUGAT9779",
            "MfrPartNumber": "…",
            "UPCCode": "",
            "Description": "…",
            "OrderedQty": 2,
            "ShippedQty": 0,
            "UnitPrice": 0.5,
            "ExtendUnitPrice": 1.0,
            "ExtendShippingCharge": 0,
            "Status": 1,
            "StatusDescription": "Unshipped",
            "BuyerRequestedCancel": false
          }
        ],
        "PackageInfoList": [
          {
            "ShipCarrier": "…",
            "ShipService": "…",
            "TrackingNumber": "…",
            "ShipDate": "…",
            "SellerPartNumber": "…",
            "MfrPartNumber": "…",
            "ShippedQty": 1,
            "Memo": ""
          }
        ]
      }
    ]
  }
}
```

- Envelope: `IsSuccess`, `SellerID`, `OperationType` = `GetOrderInfoResponse`; paging under
  `ResponseBody.PageInfo` (`TotalCount`, `TotalPageCount`, `PageIndex`, `PageSize`).
- `OrderNumber` observed as a JSON number here and a string in §10.2 — parse tolerantly.
- `OrderStatus` (response): same 0–5 codes as request `Status`; `OrderStatusDescription` is
  the human label. Item-level `Status`: **1 Unshipped · 2 Shipped · 3 Cancelled** — a
  _different_ scale from `OrderStatus`, do not conflate.
- `SalesChannel`: 0 Newegg · 1 Multi-channel · 2 Replacement · 3 NWS. `FulfillmentOption`:
  0 ship by seller · 1 ship by Newegg (SBN).
- `CustomerEmailAddress` is a masked Newegg relay (`…@marketplace.newegg.com`), never the
  buyer's real address.
- Money fields (`OrderItemAmount`, `ShippingAmount`, `DiscountAmount`, `RefundAmount`,
  `SalesTax`, `VATTotal`, `DutyTotal`, `RecyclingFeeAmount`, `OrderTotalAmount`, and item
  `UnitPrice`/`ExtendUnitPrice`/`ExtendShippingCharge`/…) are decimals in `CurrencyCode`;
  observed both as numbers (`1.0`) and strings (`"0.00"`).
- Version-gated fields: `OnTimeShipDueDate`/`DeliverDueDate` (v311), `CurrencyCode` (v313),
  `SignatureRequired` (v314), `AutoVoidTime`/`IsAutoVoid` (v313/v315). Each is optional.

**ASSUMPTION (default version):** the SDK pins `version=315` (highest documented, and the top
of the page's version table) for order reads so every mapped field is available; older
versions merely omit newer fields. Isolated behind the order adapter, overridable.

### 10.2 Get Order Status

Source: `https://developer.newegg.com/newegg_marketplace_api/order_management/get_order_status/` (2026-07-12).

```
GET https://api.newegg.com/marketplace/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version=304
GET https://api.newegg.com/marketplace/b2b/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version=304
GET https://api.newegg.com/marketplace/can/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version=304
```

A lightweight single-order status check. **GET**, no request body; `{ordernumber}` is a path
segment. Auth required; XML/JSON out. Only `version=304`. Rate limit **500 requests/hour**.

Response — a **flat object** (no envelope; XML root `QueryOrderStatusInfo`):

```json
{
  "OrderNumber": "159243598",
  "OrderStatusCode": 1,
  "OrderStatusName": "PartiallyShipped",
  "SellerID": "A006",
  "OrderDownloaded": true,
  "SalesChannel": 0,
  "FulfillmentOption": 0
}
```

- `OrderStatusCode`/`OrderStatusName`: 0 Unshipped · 1 PartiallyShipped · 2 Shipped ·
  3 Invoiced · 4 Voided · 5 PaymentPending — same codes as §10.1 `OrderStatus`; the name is
  the camel-case `OrderStatusName` value.
- `OrderDownloaded`: `"True"`/`"False"` (string boolean).
- `SalesChannel`, `FulfillmentOption`: as in §10.1.
- Errors: `SO002` (order number must be an integer 1–2147483647), `SO003` (no data found, or
  the order does not belong to this seller). Both XML `<Errors>` and JSON-array shapes (§1).
  The SDK's "try" variant maps `SO003` to a not-found (`undefined`) result, mirroring the
  inventory `CT026` handling (§5); every other error throws.

## 11. Order Management (writes)

> Extracted 2026-07-14 from the official Newegg Developer Portal order-management pages (sources
> cited per subsection). These are the **mutating** order operations — ship, cancel, mark-downloaded
> (confirmation), and remove-item. The SDK implements them under the same write-safety rules as
> inventory writes (MCP preview→apply, `NEWEGG_MCP_ALLOW_WRITES` gate) and, like feeds, treats them
> as **non-idempotent**: a request whose body may have reached Newegg is never auto-retried
> (ADR 0004). Auth required; XML/JSON in and out; each is rate limited **1000 requests/hour**.

**Shared endpoint quirk (HTTP verb ≠ semantics, cf. §2/§10.2).** Ship Order and Cancel Order both
`PUT` to `ordermgmt/orderstatus/orders/{ordernumber}` — the _same_ URL that Get Order Status (§10.2)
reads with `GET`. That path is **read-on-GET, write-on-PUT**; the `Action` field in the PUT body
selects the mutation (`1` cancel, `2` ship). Classify by this doc, never by the URL. Order
Confirmation and Remove Item use distinct paths (`…/orders/confirmation`, `ordermgmt/killitem/…`).

Response dates are Pacific Time (§2), in either `M/D/YYYY H:mm:ss` (confirmation) or an ISO-like
`YYYY-MM-DDTHH:mm:ss` / `YYYY-MM-DD HH:mm:ss` form (ship `ShipDate`, remove-item `RequestDate`) —
parse via `platform/dates.ts`. Any single-element list (`Package`, `Item`, `OrderNumber`) may be an
object instead of an array (§2).

### 11.1 Ship Order (`Action` = 2)

Source: `https://developer.newegg.com/newegg_marketplace_api/order_management/ship_order/` (2026-07-14).

```
PUT https://api.newegg.com/marketplace/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version={version}
PUT https://api.newegg.com/marketplace/b2b/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version={version}
PUT https://api.newegg.com/marketplace/can/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version={version}
```

`PUT`, only `version=304`. Updates shipment of one or more items. Newegg accepts one item split
across multiple packages but rejects a package that ships fewer than the ordered quantity of an item
without the rest being shipped in sibling packages (total shipped must equal total ordered for that
item). Shipping every item completes the order; shipping some leaves it `PartiallyShipped`.

Request — `Value.Shipment` carries a header + a `PackageList`; each `Package` has its own
carrier/tracking and an `ItemList`. (In XML the `Value` element is CDATA-wrapped XML; in JSON it is
a nested object.)

```json
{
  "Action": "2",
  "Value": {
    "Shipment": {
      "Header": { "SellerID": "A006", "SONumber": "159243598" },
      "PackageList": {
        "Package": [
          {
            "TrackingNumber": "TRACK1",
            "ShipCarrier": "Purolator",
            "ShipService": "3-5",
            "ItemList": { "Item": { "SellerPartNumber": "A006ZX-35833", "ShippedQty": "1" } }
          }
        ]
      }
    }
  }
}
```

- `Action` `2` = ship (required). `SONumber` is the order number and must equal `{ordernumber}` in
  the URL (else `SO040`); the header `SellerID` must match the URL `sellerid`.
- Per package (required): `TrackingNumber`, `ShipCarrier` (a Newegg Integrated Carrier List value),
  `ShipService`. Per item (required): `SellerPartNumber`, `ShippedQty` (> 0); `NeweggItemNumber`
  optional. `Package` and `Item` are object-or-array (§2).

Response — `PackageProcessingSummary` counts, then a `Result` with the new order status and
per-package `ProcessStatus`:

```json
{
  "IsSuccess": true,
  "PackageProcessingSummary": { "TotalPackageCount": 1, "SuccessCount": 1, "FailCount": 0 },
  "Result": {
    "OrderNumber": "159243598",
    "OrderStatus": "Shipped",
    "SellerID": "A006",
    "Shipment": {
      "PackageList": [
        {
          "TrackingNumber": "TRACK1",
          "ShipDate": "2012-02-10T15:30:01",
          "ProcessStatus": true,
          "ProcessResult": "Success",
          "ItemList": [
            {
              "NeweggItemNumber": "9SIA0060845543",
              "SellerPartNumber": "A006ZX-35833",
              "ShippedQty": 1
            }
          ]
        }
      ]
    }
  }
}
```

- **`IsSuccess` "always returns true"** per the docs — do NOT read it as the per-package outcome.
  Real success is per package: `ProcessStatus` (`true`/`false`) + `ProcessResult`, with
  `SuccessCount`/`FailCount` in the summary. **ASSUMPTION:** the SDK surfaces a partial failure
  (`FailCount > 0`, or any `ProcessStatus=false`) as an error/warning, not silent success.
- `OrderStatus` here is a **string** (`Shipped` / `PartiallyShipped`), not the §10 numeric code.
- `ShipDate` is Pacific (`YYYY-MM-DDTHH:mm:ss`).

### 11.2 Cancel Order (`Action` = 1)

Source: `https://developer.newegg.com/newegg_marketplace_api/order_management/cancel_status/` (2026-07-14).

```
PUT https://api.newegg.com/marketplace/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version={version}
PUT https://api.newegg.com/marketplace/b2b/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version={version}
PUT https://api.newegg.com/marketplace/can/ordermgmt/orderstatus/orders/{ordernumber}?sellerid={SellerID}&version={version}
```

`PUT`, only `version=304`. Same URL as Ship (§11.1) and Get Order Status (§10.2); `Action=1` selects
cancel. Only **unshipped** orders can be voided (`SO006`/`SO008`).

Request — a reason code in `Value`:

```json
{ "Action": "1", "Value": "24" }
```

- `Value` cancel reason code (required): `24` Out of Stock · `72` Customer Requested to Cancel ·
  `73` Price Error · `74` Unable to Fulfill Order (any other → `SO017`).
- **SBN caveat:** a Shipped-by-Newegg order may not cancel if the Newegg warehouse is already
  processing it; the response comes back `Processing` and the final result must be polled via Get
  SBN Order Cancellation Request Result (deferred — see the end of §11).

Response:

```json
{
  "IsSuccess": "true",
  "Result": { "OrderNumber": "159243598", "SellerID": "A006", "OrderStatus": "Void" }
}
```

- `OrderStatus`: `Void` = cancelled successfully; `Processing` = SBN cancellation accepted, result
  pending (poll separately). `IsSuccess` is a string boolean (`"true"`/`"false"`).

### 11.3 Order Confirmation (mark downloaded)

Source: `https://developer.newegg.com/newegg_marketplace_api/order_management/order_confirmation/` (2026-07-14).

```
POST https://api.newegg.com/marketplace/ordermgmt/orderstatus/orders/confirmation?sellerid={SellerID}
POST https://api.newegg.com/marketplace/b2b/ordermgmt/orderstatus/orders/confirmation?sellerid={SellerID}
POST https://api.newegg.com/marketplace/can/ordermgmt/orderstatus/orders/confirmation?sellerid={SellerID}
```

`POST` (no `{ordernumber}` path segment, no `version`). Marks one or more orders as **downloaded**
(acknowledged) on the seller portal — the workflow signal that an order has been pulled into the
seller's system. Re-marking a downloaded order is effectively a no-op, but it is still a mutation →
same write gating.

Request — `DownloadedOrderList.OrderNumber[]` (array wrapper):

```json
{
  "OperationType": "OrderConfirmationRequest",
  "RequestBody": { "DownloadedOrderList": { "OrderNumber": ["159243598"] } }
}
```

- `OperationType` fixed `OrderConfirmationRequest`. `OrderNumber` list required; `IssueUser` (an
  eligible seller-account email) optional.

Response — wrapped in `NeweggAPIResponse` (tolerate the wrapper present or absent, §8):

```json
{
  "NeweggAPIResponse": {
    "IsSuccess": "true",
    "OperationType": "OrderConfirmationResponse",
    "SellerID": "A006",
    "ResponseDate": "2/22/2012 16:38:53",
    "ResponseBody": {
      "RequestDate": "2/22/2012 16:38:53",
      "DownloadedOrderList": { "OrderNumber": "159243598" }
    }
  }
}
```

- `ResponseDate`/`RequestDate` Pacific (`M/D/YYYY H:mm:ss`). Errors use the **`CE` prefix** (`CE001`
  SellerID null/empty), not `SO` — route through the shared upstream-error path (§1).

### 11.4 Remove Item (KillItem)

Source: `https://developer.newegg.com/newegg_marketplace_api/order_management/remove_item/` (2026-07-14).

```
PUT https://api.newegg.com/marketplace/ordermgmt/killitem/orders/{ordernumber}?sellerid={SellerID}
PUT https://api.newegg.com/marketplace/b2b/ordermgmt/killitem/orders/{ordernumber}?sellerid={SellerID}
PUT https://api.newegg.com/marketplace/can/ordermgmt/killitem/orders/{ordernumber}?sellerid={SellerID}
```

`PUT` to the `killitem` path (no `version`). Removes one or more line items from an unshipped order
by `SellerPartNumber`. **Not** allowed on SBN orders (`SO005`/`SO056`).

Request — `KillItem.Order.ItemList.Item[]`:

```json
{
  "OperationType": "KillItemRequest",
  "RequestBody": {
    "KillItem": { "Order": { "ItemList": { "Item": [{ "SellerPartNumber": "AWHZ3434" }] } } }
  }
}
```

- `OperationType` fixed `KillItemRequest`. Each `Item.SellerPartNumber` required; `Item` is
  object-or-array. `IssueUser` and `Memo` (reason) optional. A repeated part# → `SO055`.

Response:

```json
{
  "IsSuccess": true,
  "OperationType": "KillItemResponse",
  "SellerID": "A006",
  "Memo": null,
  "ResponseBody": {
    "Orders": {
      "OrderNumber": "88237462",
      "Result": { "ItemList": [{ "SellerPartNumber": "AWHZ3434" }] }
    },
    "RequestDate": "2012-02-22 16:42:10"
  },
  "ResponseDate": "2012-02-22 16:42:10"
}
```

- `ResponseBody.Orders.Result.ItemList` echoes the removed items. `Memo` is `null` on success and
  carries the error description when `IsSuccess` is false. Dates Pacific (`YYYY-MM-DD HH:mm:ss`).

### 11.5 Order-write error codes

Ship/Cancel (`orderstatus/orders/{n}`) and Remove-Item (`killitem`) return the `SO*` family; Order
Confirmation returns `CE*`. Both arrive as XML `<Errors><Error><Code>` or a JSON array
`[{ "Code", "Message" }]` (§1) — route through `errors/parse-upstream.ts`. Key codes:

| Code             | Meaning (write-relevant)                                      |
| ---------------- | ------------------------------------------------------------- |
| SO001 / SO009    | Seller ID / order number null or empty                        |
| SO002            | Order number must be an integer 1–2147483647                  |
| SO003            | No data found, or the order is not this seller's              |
| SO004 / SO054    | Replacement SO with an RMA — cannot be voided                 |
| SO005 / SO056    | Cannot remove item — Shipped-by-Newegg order                  |
| SO006            | Only unshipped orders can be voided (current status `{0}`)    |
| SO008            | Order already voided                                          |
| SO011            | Only unshipped orders can be shipped (current status `{0}`)   |
| SO012            | Only shipped-by-seller orders are supported                   |
| SO014 / SO037    | `Action` must be `1` (cancel) or `2` (ship)                   |
| SO016            | Order not yet downloaded to the portal — retry after ~2 hours |
| SO017            | Cancel reason must be `24` / `72` / `73` / `74`               |
| SO020            | A package is missing shipping information                     |
| SO025 / SO027    | Some / all items already shipped                              |
| SO030            | Malformed shipment segment                                    |
| SO040            | Body order# / Seller ID ≠ the URL values                      |
| SO050 / SO055    | Invalid / repeated `SellerPartNumber` (remove-item)           |
| SO051            | Item already cancelled in Newegg's system                     |
| SO056 (ship ctx) | Premier order — must ship via Newegg Shipping Label Service   |
| CE001            | (confirmation) Seller ID null or empty                        |

`SO056` text differs by endpoint (Premier-order-ship in §11.1; SBN-remove in §11.4) — Newegg reuses
the number, so surface the message, not just the code.

**DEFERRED (not contracted here):** Get SBN Order Cancellation Request Result
(`…order_management/get_sbn_shipped_by_newegg_order_cancellation_request_result/`) — needed only to
poll the `Processing` outcome of an SBN cancel (§11.2); add when SBN cancel is implemented.

## 12. Reports Management — Item Lookup (catalog resolution)

Verified 2026-07-16 against the official pages:

- Submit: `https://developer.newegg.com/newegg_marketplace_api/reports_management/submit_report_request/submit_item_lookup_report/`
- Status: `https://developer.newegg.com/newegg_marketplace_api/reports_management/get_report_status/`
- Result: `https://developer.newegg.com/newegg_marketplace_api/reports_management/get_report_result/get_item_lookup_report/`

Async 3-step lifecycle: submit → poll status → page through the result. All three endpoints exist
on every platform via the standard prefix (`reportmgmt/…`, `b2b/reportmgmt/…`, `can/reportmgmt/…`).

**Read/write classification:** all three are READS. Report submission is a `POST`, but it creates a
report job only — it never mutates listings, prices, inventory, or orders (§2's rule: classify by
contract, not verb). Owner approved live read-only use 2026-07-16.

### 12.1 Submit Item Lookup Report

`POST {prefix}reportmgmt/report/submitrequest?sellerid={sellerid}` — rate limit **100/hour**.

```json
{
  "OperationType": "ItemLookupRequest",
  "RequestBody": {
    "RequestCriteria": {
      "Item": [
        { "UPC": "20140711101111", "Condition": "1" },
        {
          "ManufacturerName": "q-see",
          "ManufacturerPartNumber": "canmfpn20140711101",
          "PacksOrSets": 1
        }
      ]
    }
  }
}
```

- Per item: `UPC` (required if no MPN) OR `ManufacturerName` + `ManufacturerPartNumber` (both
  required if no UPC). Optional: `Condition` (integer 1–6, table in §4; Used only on Newegg.com),
  `PacksOrSets` (integer).
- Max **1000** items per request (error `RP021` beyond that).
- Response (`OperationType: "ItemLookupReportResponse"`): the request id is nested in a LIST —
  `ResponseBody.ResponseList[0].RequestId` (XML wraps it further as `ResponseList > ResponseInfo`):

```json
{
  "IsSuccess": true,
  "OperationType": "ItemLookupReportResponse",
  "SellerID": "a001",
  "ResponseBody": {
    "ResponseList": [
      {
        "RequestId": "270Z8Y3SYIGQV",
        "RequestType": "ITEM_LOOKUP",
        "RequestDate": "07/12/2014 11:34:57",
        "RequestStatus": "SUBMITTED"
      }
    ]
  }
}
```

- Dates Pacific, `MM/DD/YYYY HH:mm:ss`. `RequestStatus` on submit is `SUBMITTED`.

### 12.2 Get Report Status

`PUT {prefix}reportmgmt/report/status?sellerid={sellerid}` — rate limit **500/hour**.

```json
{
  "OperationType": "GetReportStatusRequest",
  "RequestBody": {
    "GetRequestStatus": {
      "RequestIDList": { "RequestID": "2PQBYWH4V68ZP" },
      "MaxCount": "10"
    }
  }
}
```

- NOTE the extra `GetRequestStatus` wrapper inside `RequestBody`. `RequestID` accepts a single id
  (official JSON example) — XML shows the same element repeated for multiple ids, so an array is
  the multi-id JSON form (**ASSUMPTION** for arrays; single-string form is verified).
- When `RequestID` is provided, `RequestType`/`MaxCount`/`RequestStatus`/date filters are ignored.
  `MaxCount` caps at 100. Report types include `ITEM_LOOKUP` and `ITEM_BASIC_INFO_REPORT`.
- Response (`OperationType: "GetReportStatusResponse"`): `ResponseBody.ResponseList[]` (XML nests
  `ResponseInfo`; treat as object-OR-array) with `RequestId`, `RequestType`, `RequestDate`,
  `RequestStatus`, `TotalCount`.
- `RequestStatus` enum: `SUBMITTED` | `IN_PROGRESS` | `FINISHED` | `CANCELLED`.
- Errors: `RP004`–`RP007` (date-filter validation), standard `<Errors>`/JSON-array envelope (§1).

### 12.3 Get Item Lookup Report Result

`PUT {prefix}reportmgmt/report/result?sellerid={sellerid}` — rate limit **500/hour**.

```json
{
  "OperationType": "ItemLookupRequest",
  "RequestBody": {
    "RequestID": "2PQBYWH4V68ZP",
    "PageInfo": { "PageIndex": "1", "PageSize": "100" }
  }
}
```

- `PageSize` max 100. `PageIndex` 1-based. Optional `IssueUser` (registered portal email).
- Response (`OperationType: "ItemLookupResponse"`):

```json
{
  "IsSuccess": true,
  "SellerID": "A006",
  "ResponseBody": {
    "PageInfo": { "TotalCount": 3, "TotalPageCount": 1, "PageIndex": 1, "PageSize": 100 },
    "RequestID": "27YV8H1HHRFLZ",
    "RequestDate": "02/16/2023 14:00:03",
    "ItemList": [
      {
        "ManufacturerName": "Plantronics",
        "ManufacturerPartNumber": "203500-105",
        "Condition": 1,
        "Note": "No match found."
      },
      {
        "NeweggItemNumber": "0G6-0008-003W9",
        "UPC": "017229164116",
        "Condition": 1,
        "PacksOrSets": 1,
        "ManufacturerName": "Plantronics",
        "ManufacturerPartNumber": "206110-101",
        "WebsiteShortTitle": "Plantronics Voyager 5200 …",
        "Variety": { "GroupID": 204142502, "Options": [{ "Name": "Color", "Value": "Blue" }] }
      }
    ]
  },
  "ResponseDate": "02/16/2023 14:06:04"
}
```

- The list key is `ResponseBody.ItemList` (XML: `ItemList > Item`; treat as object-OR-array).
- Each row ECHOES the submitted criteria. A row WITHOUT `NeweggItemNumber` is a miss and carries
  `Note` (e.g. `"No match found."`). Hit rows carry `NeweggItemNumber` ("Newegg's assigned number
  for item"), `UPC`, `Condition` (number; §4 table), `PacksOrSets`, `ManufacturerName`,
  `ManufacturerPartNumber`, `WebsiteShortTitle` (catalog title — useful to confirm the product),
  and optionally `Variety` (`GroupID` + `Options[{Name,Value}]`) for variant groups.
- The official JSON example is syntactically invalid (missing comma, trailing comma) — trust the
  field inventory, not the sample's punctuation. Numbers may arrive as strings elsewhere; parse
  tolerantly as always.
- **Verified live (CA, 2026-07-17):** hit lists may interleave condition-less PSEUDO-ROWS — an
  `R`-suffixed variant of the real item number (e.g. `20-250-259R` alongside `20-250-259`)
  carrying NO `Condition` field, apparently a refurb catalog echo — and the pseudo-row can come
  FIRST. The Existing Item Creation feed (§13) rejects the `R` number with "Newegg item number
  does not exist". Consumers must prefer condition-bearing rows; the SDK's `catalog.resolve`
  ranks them first.
- **Verified live (CA, 2026-07-18, 5/5 A/B reproductions): duplicate-product criteria poison the
  report.** A submission containing two criteria that match the SAME catalog product (observed:
  a UPC plus that product's manufacturer+MPN) reaches `FINISHED`, but the result endpoint then
  returns HTTP 500 `InternalError` ("currently unavailable … Please try again") on every fetch,
  permanently — indistinguishable on the wire from an outage. The identical input set minus the
  duplicate succeeds. De-duplicate inputs by product, not just by criteria value; the SDK's
  `resolve()` raises a diagnostic error for this case.

## 13. Data Feeds — Existing Item Creation (listing writes)

Creates seller listings against products **already in Newegg's catalog** (resolved via §12). This is
the `&v2` datafeed template — distinct from full item creation (`&v1`) and the basic-info feed
(`&v3`).

Verified against the official Java/C# SDKs and the docs page:

- Docs: `https://developer.newegg.com/newegg_marketplace_api/datafeed_management/existing_item_creation_feed/`
  (fetched 2026-07-17, page last updated 2021-03-09).
- Java SDK `Newegg/newegg-marketplace-sdk-java` file
  `DataFeed/src/main/java/com/newegg/marketplace/sdk/datafeed/inner/SubmitCreationCaller.java`
  (`requesttype=ITEM_DATA&v2`; `&v1` = full item creation, `&v3` = basic-info feed).
- C# SDK `Newegg/newegg-marketplace-sdk-dotnet` file
  `DataFeed/Model/SubmitFeed/ExistingItemCreationFeed.cs` (`base("2.0","BatchItemCreation")`).

**Read/write classification:** WRITE. Any live use requires explicit owner authorization in the
current session; the live test suite must never contain this surface (enforced by
`scripts/check-live-readonly.ts`).

### 13.1 Submit Existing Item Creation Feed

```
POST {prefix}datafeedmgmt/feeds/submitfeed?sellerid={id}&requesttype=ITEM_DATA&v2
```

Prefixes `""` / `b2b/` / `can/` (§1). **`&v2` is a bare flag (no `=`)** selecting the existing-item
template; `&v1` selects full item creation, `&v3` the basic-info feed.

- **Discrepancy:** the docs page (fetched 2026-07-17) omits `&v2` from the URL — the official Java
  SDK's `SubmitCreationCaller` sends `requesttype=ITEM_DATA&v2`, and the C# SDK models this feed as
  `BatchItemCreation` v2.0. The SDKs win; the docs page is treated as stale.
- Limits: **10 submits/min** (shared submitfeed budget), **3,000 records per file**, **15 MB per
  file**, **30,000 records/hour**. Request-failure errors: `DF003` / `DF004` / `DF011`.

### 13.2 Request envelope (JSON)

```json
{
  "NeweggEnvelope": {
    "Header": { "DocumentVersion": "2.0" },
    "MessageType": "BatchItemCreation",
    "Message": {
      "Itemfeed": [
        {
          "Item": [
            {
              "BasicInfo": {
                "SellerPartNumber": "...",
                "Manufacturer": "...",
                "ManufacturerPartsNumber": "...",
                "UPCOrISBN": "...",
                "NeweggItemNumber": "...",
                "Currency": "CAD",
                "MSRP": "0.00",
                "MAP": "0.00",
                "CheckoutMAP": "False",
                "SellingPrice": "9.99",
                "Shipping": "Default",
                "Inventory": "1",
                "ItemCondition": "New",
                "PacksOrSets": "1",
                "ActivationMark": "False",
                "CountryOfOrigin": "TWN",
                "LeadTime": "2",
                "ShippingTemplate": "..."
              }
            }
          ]
        }
      ]
    }
  }
}
```

- `SummaryInfo` is an XML-only required-but-EMPTY element — **omitted entirely** in the JSON
  serialization.
- There is **no `Overwrite` field in the v2 envelope** (`Overwrite` is v1-only; see §7.2 for the
  inventory feed's hard-coded `"No"`).
- Spelling landmines: `ManufacturerPartsNumber` (plural "Parts"), `UPCOrISBN`, `CheckoutMAP`,
  `ActivationMark`.
- `Itemfeed` and `Item` are arrays in JSON; numbers/prices are sent as strings.

### 13.3 BasicInfo field table

From the official docs page:

| Attribute                 | Required?    | Notes                                                                                                                                                                                                                   |
| ------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SellerPartNumber`        | Yes          | ≤40 chars incl. space; immutable once created.                                                                                                                                                                          |
| `Manufacturer`            | Yes (always) | Must match a name predefined in Newegg's system — additions via mktp.content@newegg.com.                                                                                                                                |
| `UPCOrISBN`               | Conditional  | One of {`UPCOrISBN`, `ManufacturerPartsNumber`, `NeweggItemNumber`} required. 12-digit UPC or 13-digit EAN.                                                                                                             |
| `ManufacturerPartsNumber` | Conditional  | One of the three above; ≤40 chars.                                                                                                                                                                                      |
| `NeweggItemNumber`        | Conditional  | One of the three above; Newegg's assigned catalog number (§12).                                                                                                                                                         |
| `SellingPrice`            | Yes          | String.                                                                                                                                                                                                                 |
| `Shipping`                | Yes          | Docs page values `Default` \| `Free`. **Discrepancy:** the C# SDK's carrier-speed `Shipping` enum belongs to the v1 feed — docs page wins here, to be confirmed against the first live preview.                         |
| `Inventory`               | Yes          | Integer. Default warehouse: CAN warehouse on newegg.ca, USA warehouse on the US/B2B platforms.                                                                                                                          |
| `PacksOrSets`             | Yes          | Integer; immutable once created.                                                                                                                                                                                        |
| `Currency`                | Optional     | `USD` / `CAD`; defaults CAD on newegg.ca, USD elsewhere.                                                                                                                                                                |
| `MSRP`                    | Optional     | String.                                                                                                                                                                                                                 |
| `MAP`                     | Optional     | `0` / `0.00` removes MAP; null = no change.                                                                                                                                                                             |
| `CheckoutMAP`             | Optional     | `True` / `False`.                                                                                                                                                                                                       |
| `ItemCondition`           | Optional     | `New` / `Refurbished` everywhere; `UsedLikeNew` / `UsedVeryGood` / `UsedGood` / `UsedAcceptable` (+ `ConditionDetails` + `UsedItemImages`/`ImageUrl`/`IsPrimary`) are Newegg.com-platform-only. Immutable once created. |
| `ActivationMark`          | Optional     | `True` = listed for sale, `False` = hidden/offline, null = no change.                                                                                                                                                   |
| `CountryOfOrigin`         | Optional     | ISO 3166-1 alpha-3.                                                                                                                                                                                                     |
| `LeadTime`                | Optional     | Business days 1–14; Newegg default 2.                                                                                                                                                                                   |
| `ShippingTemplate`        | Optional     | ≤200 chars; blank = no change.                                                                                                                                                                                          |

### 13.4 Submit response

Identical `SubmitFeedResponse` shape to §7.3 — `IsSuccess`, `OperationType: "SubmitFeedResponse"`,
`SellerID`, `ResponseBody.ResponseList[]` entries
`{ RequestId, RequestType: "ITEM_DATA", RequestDate (Pacific Time), RequestStatus: "SUBMITTED" }`.
The XML variant nests `ResponseList > ResponseInfo`. Parsed by the SDK's existing feed-submit parser.

### 13.5 Result

Generic `ProcessingReport` (§7.6 shape): `NeweggEnvelope > Message > ProcessingReport` with
`ProcessingSummary { ProcessedCount, SuccessCount, WithErrorCount }` and `Result[]` records carrying
`AdditionalInfo { SellerPartNumber, ManufacturerPartsNumber, UPCOrISBN, SubCategoryID }` +
`ErrorList > ErrorDescription[]` (CDATA text). Partial success is possible (e.g. `"Item Created with
Image error(s)."`).

Verified live (CA, 2026-07-17):

- Clean successes produce NO `Result` records — only warned/failed records appear; verify success
  via `ProcessingSummary.SuccessCount`, not per-record echoes. Records are isolated: one item's
  failure does not poison the rest of the feed.
- Newegg enforces **UPC + condition uniqueness per seller account**. Creating a second offer on an
  already-listed product fails with an error naming the existing offer's
  `Seller Part Number` — this error is the authoritative "already listed" signal (pre-checking is
  optional; an inventory read by UPC, §5.2 note, works as a best-effort pre-check).
- Newly created items are INVISIBLE to the inventory API (CT026) while under Newegg's content
  review (~2 h observed; docs say ≤6 h normal / ≤24 h max) and "cannot be activated" until review
  completes. Trust the ProcessingReport, then re-check after the review window.

## 14. Public storefront APIs (UNOFFICIAL)

> ⚠️ **WARNING — UNOFFICIAL.** Everything in this section is a **public retail storefront**
> endpoint, not part of the Newegg Marketplace **seller** API. There is **no official
> documentation URL**: the shapes below were **observed live on newegg.ca, 2026-07-31** with a
> plain Node `fetch` (no cookies, no credentials, no session). No SLA, no versioning, no
> deprecation notice — Newegg can change or remove these at any time, and the CDN may block
> clients that do not look like a browser. Treat every field as best-effort.
>
> **Read/write classification: READ.** These endpoints are unauthenticated and touch nothing on
> the seller account. They never carry seller credentials (§1 auth headers must NOT be sent —
> they are meaningless here and would leak secrets to a non-API host).

**Why the SDK has this at all:** the seller API exposes no competitive-pricing surface — there is
no "who else sells this / what is the buy-box price" endpoint anywhere in `contentmgmt`,
`ordermgmt`, `datafeedmgmt`, or `reportmgmt`. The storefront's own buy-box widget is the only
observed source. Available for the `ca` and `us` storefronts only; **`b2b` has no public
storefront** (the SDK throws `UnsupportedMarketplaceOperationError`).

| Marketplace | Storefront origin        |
| ----------- | ------------------------ |
| `ca`        | `https://www.newegg.ca`  |
| `us`        | `https://www.newegg.com` |
| `b2b`       | — (unsupported)          |

### 14.1 More Buying Options (all seller offers for a product)

```
GET https://www.newegg.ca/product/api/MoreBuyingOptions
      ?ParentItem=20-156-294
      &TabType=0&SortBy=0&FilterBy=&FirstCall=true&PageNum=1&PageSize=10
```

Required headers (omitting them can get the request blocked by the CDN):

| Header            | Value                                                |
| ----------------- | ---------------------------------------------------- |
| `User-Agent`      | a browser-like desktop UA string                     |
| `Accept`          | `application/json, text/plain, */*`                  |
| `Accept-Language` | `en-US,en;q=0.9`                                     |
| `Referer`         | the storefront origin, e.g. `https://www.newegg.ca/` |

`ParentItem` accepts **both** observed parent forms (both verified live):

- the dashed catalog form — `20-156-294`
- a marketplace-style parent CODE — `3C6-00T1-002H0`, `0D9-002W-000F0`

**ASSUMPTION**: `TabType` / `SortBy` / `FilterBy` / `FirstCall` / `PageNum` / `PageSize` were
copied from the retail page's own first-load request and echoed back unchanged; only their
observed values are known to work. Paging beyond page 1 was not exercised.

**Response.** HTTP `200` with `content-type: text/plain` — but the body **IS JSON**. Parse by
shape, never by content type.

```json
{
  "ItemInfo": [
    {
      "Item": "20-156-294",
      "UnitCost": 129.99,
      "ShippingCharge": 0.01,
      "Instock": true,
      "Active": "1",
      "IsActivated": true,
      "Seller": null
    },
    {
      "Item": "9SIXXXXXXXXXXX",
      "UnitCost": 134.5,
      "ShippingCharge": 0,
      "Instock": true,
      "Active": "1",
      "IsActivated": true,
      "Seller": { "SellerId": "XXXX", "SellerName": "Example Seller Inc", "SellerRating": 4.8 }
    }
  ],
  "TabInfo": [],
  "Total": 2,
  "CurrentPageNum": 1,
  "PageCount": 1
}
```

Field notes (only the fields the SDK relies on; each row carries many more):

| Field            | Notes                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Item`           | The offer's item number. **Newegg first-party offers echo the PARENT catalog number** (e.g. `20-156-294`); marketplace offers carry the seller offer number (`9SI…`).                                                                |
| `UnitCost`       | Offer price, storefront currency (CAD on `.ca`). Number in observation; coerce defensively.                                                                                                                                          |
| `ShippingCharge` | **CAUTION: `0.01` is observed on offers the page itself labels "Free Shipping".** It is a raw/sentinel value — a non-zero `ShippingCharge` does NOT reliably mean paid shipping. Expose as-is; do not derive a landed price from it. |
| `Instock`        | Boolean.                                                                                                                                                                                                                             |
| `Active`         | String `"1"` / `"0"`; `IsActivated` is the boolean twin. Either may be missing — read both.                                                                                                                                          |
| `Seller`         | Object **or null**. `null` (or `{ "SellerId": "", "SellerName": null }`) ⇒ the offer is **Newegg first-party**. Marketplace offers carry `SellerId` + `SellerName` (+ `SellerRating`, …).                                            |
| `Total`          | Offer count for the product. `CurrentPageNum` / `PageCount` describe paging.                                                                                                                                                         |

**ASSUMPTION — offer ordering is the buy box.** `ItemInfo` ordering appears to be the
storefront's featured ranking: in every observation the **first** entry matched the offer shown
in the page's buy box. This is not documented and not guaranteed; the SDK surfaces
`buyBox = offers[0]` under exactly this assumption.

**ASSUMPTION — deactivated/out-of-stock rows.** Rows with `Active: "0"` / `Instock: false` were
observed in the list; whether the storefront always includes them (and whether they can ever rank
first) is unverified.

### 14.2 Parent-number resolution from a seller offer number

MoreBuyingOptions is keyed by the **parent** product, not by a seller offer number. Given a `9SI…`
offer number, the public product page redirects to its parent (verified live 2026-07-31):

```
GET https://www.newegg.ca/p/<offerNumber>      (redirect: "manual" — do NOT follow)
→ 301, Location: …
```

Two `Location` shapes were observed; both yield a usable `ParentItem`:

| `Location`                                       | Parent                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `https://www.newegg.ca/<slug>/p/N82E168XXXXXXXX` | dashed numeric form of the 8 digits: `N82E16820156294` → `20-156-294` (`XX-XXX-XXX`)         |
| `https://www.newegg.ca/p/<CODE>`                 | the CODE itself (`3C6-00T1-002H0`, `0D9-002W-000F0`) — pass straight through as `ParentItem` |

The redirect target **is** the answer, so the request must use manual redirect handling. No
`Location`, or a `Location` with no `/p/<value>` segment, is a hard failure (the SDK throws
`NeweggApiError`) — never silently fall back to the offer number.

**ASSUMPTION**: the `N82E168` prefix is treated as fixed-width (`N82E16` + one category digit +
the 8 catalog digits); only 15-character product-page numbers were observed.

### 14.3 SDK mapping

`client.storefront.getOffers({ itemNumber })` → one §14.1 request;
`client.storefront.getOffers({ offerNumber })` → one §14.2 redirect probe, then one §14.1 request.
Offers are normalized to `{ offerItemNumber, sellerName, sellerId, isNewegg, price,
shippingCharge, inStock, active }`; rows without an item number or a parseable price are dropped.
No local rate-limit budget is applied (these are not seller-API calls and carry no
`X-RateLimit-*` headers) — callers should throttle their own polling.
