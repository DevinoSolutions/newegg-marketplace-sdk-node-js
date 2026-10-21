# @devino/newegg-marketplace-sdk

Transport-independent TypeScript SDK for the Newegg Marketplace API (US, B2B and Canada
marketplaces): inventory, prices, orders, reports, RMAs and refunds, catalog and reference
lookups, and existing-item listing creation.

- **One runtime dependency** (`zod`). No I/O at import time; no environment variables read on
  your behalf.
- **Normalized domain types** over Newegg's inconsistent, platform-specific wire shapes.
- **Safety-first writes**: preview → apply, last-write-wins deduplication, direct-vs-feed
  strategy selection, and an indeterminate-feed-submission recovery path.

> The `@devino` scope is a placeholder chosen to be easy to find-and-replace before you
> publish under your own npm organization.

## Requirements

- Node.js >= 22.12.0
- ESM only (`"type": "module"`); there is no CommonJS build.

## Installation

```bash
npm install @devino/newegg-marketplace-sdk
```

## Quick start

```ts
import { createNeweggClient } from "@devino/newegg-marketplace-sdk";

const client = createNeweggClient({
  sellerId: process.env.NEWEGG_SELLER_ID!,
  apiKey: process.env.NEWEGG_API_KEY!,
  secretKey: process.env.NEWEGG_SECRET_KEY!,
  marketplace: "us",
  // Strongly recommended: the marketplace these keys were issued for. Newegg ignores the URL prefix,
  // so without it Newegg.ca keys would silently serve the CA account under a "us" client (ADR 0006).
  credentialMarketplace: "us",
});

// Fail-fast credential preflight (read-only). Throws immediately if the credentials are wrong
// or unauthorized, so you validate once at startup instead of scattering checks everywhere.
await client.verifyCredentials();

// Preview validates, dedups (last-write-wins), and picks direct vs feed — no write happens.
const preview = await client.inventory.previewUpdate([
  {
    identifier: { type: "sellerPartNumber", value: "EXAMPLE-SKU" },
    warehouseLocation: "USA", // ISO 3166-1 alpha-3; required for US operations
    quantity: 12,
  },
]);
console.log(preview.strategy, preview.normalizedUpdates, preview.zeroQuantityCount);

// Apply the reviewed plan; wait for any feed to finish processing.
const result = await client.inventory.updateMany(preview.normalizedUpdates, {
  strategy: "auto",
  waitForFeedCompletion: true,
});
console.log(result.items, result.feedJobs);
```

`createNeweggClient` validates its configuration synchronously and throws
`NeweggConfigurationError` if anything is wrong. Credentials belong to a **seller account, not to a
URL prefix**: Newegg authenticates on `sellerId` + keys only and ignores `/b2b/` and `/can/`, so keys
issued for one marketplace silently serve that account under any other. Pass `credentialMarketplace` (the
marketplace the keys were issued for) and a mismatch throws `NeweggMarketplaceMismatchError` before any
request; omitting it keeps the old, unsafe behaviour. Order reads also throw it when a whole page is in the
wrong marketplace's currency (CAD on `ca`; USD on `us`/`b2b` is an assumption). See ADR 0006.

## Reading inventory

```ts
const snapshot = await client.inventory.getItem({
  identifier: { type: "sellerPartNumber", value: "EXAMPLE-SKU" },
  warehouses: ["USA"], // US only; ignored on B2B/CA
});
console.log(snapshot.totalAvailableQuantity, snapshot.warehouses);

const batch = await client.inventory.getMany({
  identifiers: [
    { type: "sellerPartNumber", value: "SKU-1" },
    { type: "neweggItemNumber", value: "9SIA0060884598" },
  ],
}); // large lists are chunked at 100 identifiers per request
console.log(batch.items, batch.missingIdentifiers);
```

## Reading prices

```ts
const price = await client.pricing.get({
  identifier: { type: "sellerPartNumber", value: "EXAMPLE-SKU" },
  countries: ["USA"], // US only; ignored on B2B/CA
});
for (const entry of price.prices) {
  // US: one entry per destination country. B2B/CA: one entry; the currency is inferred
  // from the marketplace (USD for b2b, CAD for ca) and flagged `currencyInferred`.
  console.log(entry.countryCode, entry.currency, entry.sellingPrice, entry.map, entry.promotions);
}

const batch = await client.pricing.getMany({
  identifiers: [
    { type: "sellerPartNumber", value: "SKU-1" },
    { type: "neweggItemNumber", value: "9SIA0060884598" },
  ],
}); // 1-100 single reads fanned out with bounded concurrency
console.log(batch.items, batch.missingIdentifiers, batch.failures);
```

## What you get

- **`client.pricing`** — reads `get`, `tryGet`, `getMany`, `previewUpdate` (Get Item Price;
  never mutate) and the write `update` (selling price only, absolute, read back to verify).
- **`client.reports`** — read-only Reports Management reports (a report submission creates a
  report job and mutates nothing): `settlementSummary` and `settlementTransactions` (paged JSON),
  `dailyInventory` (all platforms) and `dailyPrice` (Newegg.com only), whose result is an FTP
  file the SDK downloads and parses for you. Each has `submit`, `status`, `result`,
  `waitForRequest` and `waitForResult` (`ReportTimeoutError` carries the `requestId` so you
  continue instead of resubmitting; 100 submissions/hour). The file URL embeds credentials and
  is never exposed or logged.
  Settlement reports wait up to 300 s by default (a Settlement Summary took ~170 s live); the daily
  file reports 120 s; pass `timeoutMs` to override.
  Also: `itemBasicInfo` (file report listing **every listing** - SKU, Newegg item number, MPN, UPC,
  title, active flag, variants; no price/inventory, join `dailyInventory` for those) and the async
  `orderList` / `rmaList` reports (paged, rows are the same `Order` / `Rma` shapes as
  `orders.list` / `rma.list`; the required result `version` defaults to 309 / 320 and is validated
  per platform). These three wait up to 300 s (live: 2-4 minutes). Item Ranking (a synchronous,
  Account-Manager-only `contentmgmt` call) and the China-only Tax Setting report are not built.
- **`client.rma`** / **`client.refunds`** - Service Management (contracts §18, §20). Reads:
  `rma.list/get/tryGet` (`version` defaults to 320) and
  `refunds.list/get/tryGet/listRequests/getRequestStatus`. **Writes** (each has a read-only
  `preview*` twin that reports blockers and warnings): `rma.submit/edit/process/reject` and
  `refunds.issue` (a courtesy refund; the commission is not refunded). Ambiguous write failures
  throw `IndeterminateServiceWriteError` and are never auto-retried. Amounts are USD (Newegg.com,
  B2B) or CAD (Newegg.ca); `Rma.customer` holds buyer PII that the MCP tools deliberately never
  surface.
- **`client.orders`** - reads `list`, `get`, `tryGet`, `getStatus`, `tryGetStatus`, `listAdditionalInfo`, `getAdditionalInfo`, `tryGetAdditionalInfo` (Newegg.com only; order info is a
  read even though Newegg uses `PUT`); **writes** `ship`, `cancel`, `confirmDownload`,
  `removeItems`. Orders carry buyer PII in `customer`.
- **`client.catalog`** - read-only Item Lookup Report: `resolve` (UPC / manufacturer part number /
  Newegg item number to Newegg item numbers), plus `submitLookup`, `lookupStatus`, `lookupResult`.
- **`client.listings`** - `previewCreate` (offline) and **`create`** (write): add seller offers
  on EXISTING Newegg items through an `ITEM_DATA` feed. It never creates product records.
- **`client.volumeDiscounts`** - reads `get`, `tryGet` (Get Volume Discount is a `PUT`, still a read);
  `previewUpdate` (offline) and **`update`** (write): set 1-3 quantity tiers per item through a
  `VOLUME_DISCOUNT_DATA` feed. Newegg.ca only for writes; an update replaces the item's whole discount.
- **`client.reference`** - read-only: `getSellerStatus`, `listIndustries`, `listSubcategories`,
  `listSubcategoryProperties`, `listPropertyValues` (requires `subcategoryId`).
- **`client.sbn`** - read-only Shipped-by-Newegg inbound shipments: `listShipments`,
  `getRequestStatus`, `getRequestResult`, `listWarehouses` (three are `PUT` on the wire but only
  read). Newegg.com (`us`) and Newegg Business (`b2b`) only; `ca` throws
  `UnsupportedMarketplaceOperationError`. Label download URLs may embed credentials and are never
  returned (`labels` carry type, host and file name only). Creating or voiding an inbound shipment
  is not implemented.
- **`client.ads`** - read-only Sponsored Ads (Newegg.com `us` only; every call is a `POST` but only
  reads): `listCampaigns`, `listGroups`, `listProducts`, `listKeywords`, `listNegativeKeywords`,
  `listMatchTypes`, `suggestKeywords`, `suggestCategoryTargeting`, `suggestItemTargeting`, and the
  synchronous `getGroupPerformance`, `getProductPerformance`, `getKeywordPerformance` (contracts §25).
  `b2b` / `ca` throw `UnsupportedMarketplaceOperationError`. Creating or changing campaigns, groups,
  products, keywords or bids is not implemented.
- **`client.storefront`** - UNOFFICIAL, read-only reader of the public storefront's buy box and
  competing offers (`getOffers`; `us`/`ca` only; no SLA).
- **`client.inventory`** — `getItem`, `getMany`, `previewUpdate`, `updateItem`, `updateMany`.
  `updateMany` takes `strategy: "direct" | "feed" | "auto"` (default `auto`; feeds above
  `strategy.autoFeedThreshold` post-dedup items, default 8).
- **`client.feeds`** — `submitInventoryFeed`, `getStatus`, `getResult`, and `waitForResult`
  (bounded exponential polling that returns a `timeout` outcome instead of throwing). The feed
  envelope `Overwrite` is always `"No"`.
- **`client.verifyCredentials()`** — read-only, fail-fast startup check that credentials are
  actually accepted by Newegg (throws `NeweggAuthenticationError` on bad creds).
- **`client.service`** — `getStatus(domain?)` for Newegg service availability.
- **Typed errors** — every failure is a `NeweggError` subclass with a stable `code`, a
  `retryable` flag, a `correlationId`, and (when present) the upstream `neweggErrorCode`.
  Feed submissions never blindly retry after an ambiguous send; they raise
  `IndeterminateFeedSubmissionError` with a recovery path.
- **Injectable everything** — `logger`, `fetch`, `retry`, `rateLimitStore`, `operationStore`.
  Credentials, headers, and secrets never appear in errors, logs, or `raw` payloads.

## Examples

Runnable, typechecked examples live in the repository's
[`examples/`](https://github.com/DevinoSolutions/newegg-marketplace-sdk-node-js/tree/main/examples):
`sdk-basic`, `sdk-batch-inventory`, `sdk-orders-and-reports` (read-only) and
`sdk-pricing-preview` (preview-only). They read credentials from the environment.

## Testing helpers

A separate subpath provides a mock-fetch harness for unit tests, with no network:

```ts
import { createMockFetch } from "@devino/newegg-marketplace-sdk/testing";
```

## Documentation

The binding public-API contract and deep-dive guides live in the
[repository](https://github.com/DevinoSolutions/newegg-marketplace-sdk-node-js):

- Inventory strategies (direct vs feed, dedup, chunking, polling): `docs/inventory-strategies.md`
- Platform differences (US vs B2B vs CA): `docs/platform-differences.md`
- Error handling and recovery: `docs/error-handling.md`

## License

[MIT](../../LICENSE)
