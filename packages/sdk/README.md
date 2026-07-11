# @devino/newegg-marketplace-sdk

Transport-independent TypeScript SDK for the Newegg Marketplace API, with first-class
inventory management across Newegg's US, B2B, and Canada marketplaces.

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
`NeweggConfigurationError` if anything is wrong. Credentials are **platform-specific** — a US
key is not valid on B2B or CA.

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

## What you get

- **`client.inventory`** — `getItem`, `getMany`, `previewUpdate`, `updateItem`, `updateMany`.
  `updateMany` takes `strategy: "direct" | "feed" | "auto"` (default `auto`; feeds above
  `strategy.autoFeedThreshold` post-dedup items, default 8).
- **`client.feeds`** — `submitInventoryFeed`, `getStatus`, `getResult`, and `waitForResult`
  (bounded exponential polling that returns a `timeout` outcome instead of throwing).
- **`client.verifyCredentials()`** — read-only, fail-fast startup check that credentials are
  actually accepted by Newegg (throws `NeweggAuthenticationError` on bad creds).
- **`client.service`** — `getStatus(domain?)` for Newegg service availability.
- **Typed errors** — every failure is a `NeweggError` subclass with a stable `code`, a
  `retryable` flag, a `correlationId`, and (when present) the upstream `neweggErrorCode`.
  Feed submissions never blindly retry after an ambiguous send; they raise
  `IndeterminateFeedSubmissionError` with a recovery path.
- **Injectable everything** — `logger`, `fetch`, `retry`, `rateLimitStore`, `operationStore`.
  Credentials, headers, and secrets never appear in errors, logs, or `raw` payloads.

## Testing helpers

A separate subpath provides a mock-fetch harness for unit tests, with no network:

```ts
import { createMockFetch } from "@devino/newegg-marketplace-sdk/testing";
```

## Documentation

The binding public-API contract and deep-dive guides live in the
[repository](https://github.com/devino/newegg-marketplace-sdk-node-js):

- Inventory strategies (direct vs feed, dedup, chunking, polling): `docs/inventory-strategies.md`
- Platform differences (US vs B2B vs CA): `docs/platform-differences.md`
- Error handling and recovery: `docs/error-handling.md`

## License

[MIT](../../LICENSE)
