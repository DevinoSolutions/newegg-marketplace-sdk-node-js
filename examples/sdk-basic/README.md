# example-sdk-basic

Minimal, read-only use of `@devino/newegg-marketplace-sdk`: check service status, read one
item's inventory, and preview an inventory update. No write happens unless you opt in.

## What it shows

- Creating a client with `createNeweggClient` for the marketplace in `NEWEGG_MARKETPLACE`
  (accepts `us` | `b2b` | `ca`, case-insensitive; the Newegg `can` alias maps to `ca`).
- `service.getStatus()`, `inventory.getItem(...)`, and `inventory.previewUpdate(...)`.
- Handling `NeweggError` with its typed fields (`code`, `neweggErrorCode`, `retryable`, …).

## Environment

Required: `NEWEGG_SELLER_ID`, `NEWEGG_API_KEY`, `NEWEGG_SECRET_KEY`, `NEWEGG_MARKETPLACE`.
Optional: `EXAMPLE_SELLER_PART_NUMBER` (default `EXAMPLE-SKU`), `EXAMPLE_QUANTITY` (default `5`).

Credentials are read from the environment and never printed. Never commit real values — see
[`.env.example`](../../.env.example).

## Run

```bash
NEWEGG_SELLER_ID=... NEWEGG_API_KEY=... NEWEGG_SECRET_KEY=... NEWEGG_MARKETPLACE=us \
  npm run start -w example-sdk-basic
```

## Writes

Read-only by default. The mutating `updateMany` call is gated behind `RUN_WRITE_EXAMPLE=yes`
and **writes to a REAL Newegg account** — leave it unset to stay read-only.

## Typecheck

```bash
npm run typecheck -w example-sdk-basic
```
