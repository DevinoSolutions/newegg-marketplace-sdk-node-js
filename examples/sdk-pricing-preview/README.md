# example-sdk-pricing-preview

Preview-only: read an item's price and risk-check a selling-price change without sending it.

## What it shows

- `pricing.get({ identifier, countries? })` — current price entries (US: one per destination
  country; B2B/CA: one).
- `pricing.previewUpdate([...])` — current vs new price, percent change, `blockers` and `warnings`.
  It reads and plans; it never writes.

## Environment

Required: `NEWEGG_SELLER_ID`, `NEWEGG_API_KEY`, `NEWEGG_SECRET_KEY`, `NEWEGG_MARKETPLACE`.
Optional: `EXAMPLE_SELLER_PART_NUMBER` (default `YOUR-SKU`), `EXAMPLE_NEW_PRICE` (default `19.99`).

Credentials are read from the environment and never printed. See
[`.env.example`](../../.env.example).

## Run

```bash
NEWEGG_SELLER_ID=... NEWEGG_API_KEY=... NEWEGG_SECRET_KEY=... NEWEGG_MARKETPLACE=us \
  npm run start -w example-sdk-pricing-preview
```

## Writes

None. This example never calls `pricing.update`, which writes a real selling price. Review the
preview, then apply deliberately in your own code or through the MCP preview → apply flow.

## Typecheck

```bash
npm run typecheck -w example-sdk-pricing-preview
```
