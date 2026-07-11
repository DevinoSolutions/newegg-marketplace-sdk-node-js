# Platform differences: US vs B2B vs Canada

Newegg exposes three marketplaces through one API host, but they differ in far more than a
URL prefix: different endpoints, different HTTP methods on the _same_ URL, different feed
document versions, different warehouse models, and platform-specific credentials. The SDK
hides these behind one `PlatformAdapter` per marketplace (ADR 0002), selected by
`NeweggClientConfig.marketplace` (`"us" | "b2b" | "ca"`).

Every request/response snippet below is lifted from the verified wire contracts in
`docs/research/newegg-api-contracts.md`; section numbers (§) refer to that file. Items
marked **assumption** were not fully specified by Newegg's documentation and are isolated
behind named SDK modules so a doc correction is a one-file change.

---

## Base paths (§2)

| Marketplace              | `marketplace` value | Base path                                 |
| ------------------------ | ------------------- | ----------------------------------------- |
| Newegg.com (US)          | `us`                | `https://api.newegg.com/marketplace/`     |
| Neweggbusiness.com (B2B) | `b2b`               | `https://api.newegg.com/marketplace/b2b/` |
| Newegg.ca (Canada)       | `ca`                | `https://api.newegg.com/marketplace/can/` |

URLs are **case-sensitive** and must be lowercase **except the Seller ID value**, which
keeps its original case. No spaces or line breaks appear in URLs. The SDK builds every URL
with `URL`/`URLSearchParams` and lowercase path constants.

---

## Endpoint & method matrix

The single most error-prone difference: **on US international inventory the HTTP method
selects the operation** — `PUT` reads, `POST` writes, against the _same_ URL. B2B/CA invert
the methods and use _different_ URLs for read and write.

| Operation      | US (`us`)                                                                  | B2B / Canada (`b2b`, `ca`)                                                           |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Single read    | `PUT contentmgmt/item/international/inventory` (§5.1)                      | `POST contentmgmt/item/inventory?...&version=304` (§5.2)                             |
| Batch read     | `POST contentmgmt/item/international/inventorylist` (§5.3)                 | `POST contentmgmt/item/inventorylist` (§5.4)                                         |
| Direct write   | `POST contentmgmt/item/international/inventory` (§6.1)                     | `PUT contentmgmt/item/inventoryandprice` (§6.2)                                      |
| Feed submit    | `POST datafeedmgmt/feeds/submitfeed?...&requesttype=INVENTORY_DATA` (§7.1) | `POST datafeedmgmt/feeds/submitfeed?...&requesttype=INVENTORY_AND_PRICE_DATA` (§7.2) |
| Feed status    | `PUT datafeedmgmt/feeds/status` (§7.5)                                     | `PUT {b2b\|can/}datafeedmgmt/feeds/status` (§7.5)                                    |
| Feed result    | `GET datafeedmgmt/feeds/result/{RequestId}` (§7.6)                         | `GET {b2b\|can/}datafeedmgmt/feeds/result/{RequestId}` (§7.6)                        |
| Service status | `GET {domain}/servicestatus` (§8)                                          | `GET {b2b\|can/}{domain}/servicestatus` (§8)                                         |

> Reads and writes share the US URL `contentmgmt/item/international/inventory`. `PUT` is the
> read; `POST` is the write. Confusing the two silently performs the wrong operation, which
> is why the SDK pins method-per-operation inside the US adapter rather than deriving it.

---

## Comparison at a glance

| Dimension                         | US (`us`)                                 | B2B (`b2b`)                                    | Canada (`ca`)                                  |
| --------------------------------- | ----------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| Base path                         | `/marketplace/`                           | `/marketplace/b2b/`                            | `/marketplace/can/`                            |
| Single-read method / URL          | `PUT .../international/inventory`         | `POST .../item/inventory`                      | `POST .../item/inventory`                      |
| Single read `version=304`         | no                                        | **yes** (§5.2)                                 | **yes** (§5.2)                                 |
| Direct-write method / URL         | `POST .../international/inventory`        | `PUT .../item/inventoryandprice`               | `PUT .../item/inventoryandprice`               |
| Direct write body                 | `InventoryList.Inventory[]` per warehouse | inventory-only subset `{Type,Value,Inventory}` | inventory-only subset `{Type,Value,Inventory}` |
| Feed request type                 | `INVENTORY_DATA`                          | `INVENTORY_AND_PRICE_DATA`                     | `INVENTORY_AND_PRICE_DATA`                     |
| Feed `DocumentVersion`            | `2.0`                                     | `1.0`                                          | `1.0`                                          |
| Feed envelope `Overwrite`         | not present                               | present, **hard-coded `"No"`**                 | present, **hard-coded `"No"`**                 |
| Warehouse model                   | multi-warehouse, ISO 3166-1 alpha-3 codes | single default warehouse                       | single default warehouse                       |
| `Active` flag in reads            | not returned                              | returned (`"0"`/`"1"`)                         | returned (`"0"`/`"1"`)                         |
| SBN (Shipped-by-Newegg) inventory | read-only breakdown                       | read-only breakdown                            | read-only breakdown                            |
| Credentials                       | US-only                                   | B2B-only                                       | CA-only                                        |

---

## Reads

### US single read — Get Inventory (International) (§5.1)

`PUT .../contentmgmt/item/international/inventory?sellerid={SellerID}`

```json
{
  "Type": "1",
  "Value": "A006testitem201201021459",
  "WarehouseList": { "WarehouseLocation": ["USA", "AUS"] }
}
```

Response (numbers arrive as **strings**; `FulfillmentOption` `"0"` = shipped by seller,
`"1"` = shipped by Newegg/SBN, which breaks down per Newegg `WarehouseCode`):

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

### B2B / CA single read — Get Item Inventory (§5.2)

`POST .../{b2b|can/}contentmgmt/item/inventory?sellerid={SellerID}&version=304`

Request: `{ "Type": "1", "Value": "A006testitem201201021459" }`

The `version=304` query parameter is part of the documented URL and is sent only on this
B2B/CA single-item read. Response fields are **mixed types on the wire** —
`AvailableQuantity` has been observed both as the number `71` and the string `"50"`; the SDK
coerces tolerantly via zod:

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

The XML form of this response also shows `WarehouseCode` `"SBS"` — the shipped-by-seller
bucket — inside `WarehouseAllocation`.

### US batch read (§5.3) vs B2B / CA batch read (§5.4)

US batch (`POST .../international/inventorylist`) accepts a `WarehouseList` **string array**
(note: different shape from the single-item read's object form):

```json
{ "Type": "1", "Values": ["SKU-1", "SKU-2"], "WarehouseList": ["USA", "AUS"] }
```

B2B/CA batch (`POST .../item/inventorylist`) takes **no** `WarehouseList` and **no**
`version` parameter: `{ "Type": "1", "Values": ["SKU-1","SKU-2"] }`.

Both return the same envelope; B2B/CA items are flat rather than nested per warehouse:

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

The SDK normalizes all of the above into a single `InventoryItemSnapshot` /
`InventoryBatchSnapshot` shape regardless of platform, exposing `totalAvailableQuantity`
and a `warehouses[]` breakdown, plus `active` (B2B/CA only).

---

## Direct writes

### US — Update Item Inventory (International) (§6.1)

`POST .../contentmgmt/item/international/inventory?sellerid={SellerID}` (same URL as the
read; `POST` = write). Quantities are serialized as strings to match Newegg's sample, and
`WarehouseLocation` is an ISO 3166-1 alpha-3 country code:

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

Limit: 10,000 requests/hour.

### B2B / CA — Update Inventory and Price, inventory-only (§6.2)

`PUT .../{b2b|can/}contentmgmt/item/inventoryandprice?sellerid={SellerID}`. Newegg's full
sample includes price fields; **the SDK sends only the inventory subset** and never emits
`Active`, `FulfillmentOption`, or any price field:

```json
{ "Type": "1", "Value": "A006BSP3", "Inventory": "20" }
```

This is inventory-only by design (see [Current limitations](#current-limitations-recap)).
Sending `Active` could activate or deactivate a listing; omitting it means "no change" per
Newegg's docs.

---

## Feeds

### US — Inventory Update Feed (§7.1)

`POST .../datafeedmgmt/feeds/submitfeed?...&requesttype=INVENTORY_DATA`, envelope
`DocumentVersion` **`2.0`**:

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

`SellerPartNumber` is required; `NeweggItemNumber` is optional; one warehouse per region per
item. `FulfillmentOption` is `"Seller"` — feeds cannot touch SBN inventory. The SDK always
serializes `Item` as an array (Newegg's single-item sample nests it as an object, an
XML-to-JSON artifact).

### B2B / CA — Inventory and Price Feed, inventory-only (§7.2)

`POST .../{b2b|can/}datafeedmgmt/feeds/submitfeed?...&requesttype=INVENTORY_AND_PRICE_DATA`,
envelope `DocumentVersion` **`1.0`**, with an envelope-level `Overwrite`:

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

> **`Overwrite` is hard-coded to `"No"` and cannot be changed through this SDK.** Newegg's
> documentation warns that `Overwrite: "Yes"` _"will have the added effect of deactivating
> all of your items from the website not listed on this datafeed."_ Because the inventory
> API only ever sends a subset of your catalog, a `"Yes"` here would deactivate every item
> you did not include — so it is structurally unavailable (and impossible via the MCP
> server; see `mcp-security.md`).

### Feed submit response, feed limits, status, result

The submit response, `RequestId` formats, feed limits (10,000 records/file, 10
submissions/minute, 100,000 records/hour), status query, and processing-report semantics
are platform-independent and covered in `inventory-strategies.md` and §7.3–§7.6. One
platform-independent limitation worth repeating here: **feed-status date-range filters are
intentionally not implemented** (§7.5) — status is queried by request ID only.

---

## Warehouse semantics

- **US** is multi-warehouse and region-aware. `WarehouseLocation` is an ISO 3166-1 alpha-3
  country code (`USA`, `AUS`, …), uppercase, and is **required** for US inventory
  operations. Reads can request a specific set via `GetItemInput.warehouses` /
  `GetManyInput.warehouses`. Newegg's shipped-by-Newegg (SBN) allocation is broken down per
  internal `WarehouseCode`.
- **B2B / Canada** use **default-warehouse** semantics. Direct updates carry no
  `WarehouseLocation`; the update applies to the platform's default warehouse. Reads may
  still return a `WarehouseAllocation` breakdown, including the `"SBS"` (shipped-by-seller)
  bucket.

The SDK models both uniformly: `WarehouseInventory.location` holds an ISO alpha-3 country
for US or a Newegg warehouse/SBS code for B2B/CA, and `fulfillment` is normalized to
`"seller"` / `"newegg"`.

## SBN and deactivated listings

Two behaviours from Newegg's docs (§6.2), verbatim, that the SDK honours rather than works
around:

- _"You're not able to update the inventory for a SBN (Shipped by Newegg) item."_ SBN
  quantities are read-only; the SDK never sends `FulfillmentOption` on a write, so it cannot
  target SBN stock.
- _"Once an item has been deactivated, all price and inventory update requests shall be
  disregarded."_ An update to a deactivated listing will appear accepted but has no effect —
  another reason to `previewUpdate` and to read back critical items.

---

## Credentials are platform-specific

> **A US API key is not valid on `/b2b/` or `/can/`, and vice versa.** Each marketplace
> requires its own credential set.

When you use the wrong credentials for a platform, the Newegg gateway answers `HTTP 401`.
During live verification on 2026-07-10 (§9), read-only probes with the available CA
credentials returned **`HTTP 401` with the plain-text body `Gateway: Seller Auth failed.`**
on the CA, US, and B2B prefixes alike — the endpoints and header format matched the docs,
but the credentials were not accepted on any platform at test time. The SDK surfaces this as
a `NeweggAuthenticationError` / `NeweggAuthorizationError`; note the body is **plain text,
not JSON**, which is why the error parser tolerates non-JSON bodies (see
`error-handling.md`).

---

## Assumptions box

The following are **documented assumptions** — behaviours Newegg's docs did not fully
specify at extraction time. Each is isolated behind a named SDK module so a correction is a
one-file change (ADR 0002).

| Assumption               | Value used                                                                                               | Isolated in                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Item condition codes     | `1`=New, `2`=Refurbished, `3`=Used-Like New, `4`=Used-Very Good, `5`=Used-Good, `6`=Used-Acceptable (§4) | `packages/sdk/src/schemas/condition.ts`                                      |
| Batch-read chunk size    | 100 identifiers per `Values` request (§5.3)                                                              | `packages/sdk/src/inventory/constants.ts` (`GET_BATCH_INVENTORY_MAX_VALUES`) |
| Feed-status date filters | not implemented; query by request ID only (§7.5)                                                         | feed status adapter                                                          |
| Datetime timezone        | all Newegg datetimes are **Pacific Time** (§2)                                                           | response normalizers                                                         |

<a id="current-limitations-recap"></a>

### Current limitations recap

- **Inventory-only.** No price, MAP, shipping, or activation fields are ever written on any
  platform. The B2B/CA "Inventory and Price" endpoints and feeds are used with an
  inventory-only body.
- **No catalog overwrite.** `Overwrite` is hard-coded `"No"`.
- **No SBN writes.** Shipped-by-Newegg inventory is read-only.
- **Live acceptance unverified.** Endpoints and header format are verified against Newegg's
  docs; live credential acceptance was pending as of 2026-07-10 (§9).
