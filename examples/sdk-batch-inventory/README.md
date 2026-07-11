# example-sdk-batch-inventory

Batch inventory updates with `@devino/newegg-marketplace-sdk`: build ~25 updates
programmatically (including deliberate duplicates and a zero-quantity entry), preview the
resulting plan, and read several items back. No write happens unless you opt in.

## What it shows

- Constructing an `InventoryUpdate[]` with duplicate `SKU + warehouse` entries (collapsed
  by last-write-wins dedup) and a valid zero-quantity update.
- `inventory.previewUpdate(...)` reporting `strategy`, `deduplicated`, `zeroQuantityCount`,
  and `plannedFeedCount`.
- `inventory.getMany(...)` for the first few identifiers.
- The feed chunking rule (up to `INVENTORY_FEED_MAX_RECORDS` = 10,000 records per feed; a
  10,001-record operation spans two feeds).

## Environment

Required: `NEWEGG_SELLER_ID`, `NEWEGG_API_KEY`, `NEWEGG_SECRET_KEY`, `NEWEGG_MARKETPLACE`.
Optional: `EXAMPLE_SKU_PREFIX` (default `EXAMPLE-SKU-`).

Credentials are read from the environment and never printed. Never commit real values — see
[`.env.example`](../../.env.example).

## Run

```bash
NEWEGG_SELLER_ID=... NEWEGG_API_KEY=... NEWEGG_SECRET_KEY=... NEWEGG_MARKETPLACE=us \
  npm run start -w example-sdk-batch-inventory
```

## Writes

Read-only by default. The mutating `updateMany` call (`strategy: "auto"`,
`waitForFeedCompletion: true`) is gated behind `RUN_WRITE_EXAMPLE=yes` and **writes to a REAL
Newegg account** — leave it unset to stay read-only.

## Typecheck

```bash
npm run typecheck -w example-sdk-batch-inventory
```
