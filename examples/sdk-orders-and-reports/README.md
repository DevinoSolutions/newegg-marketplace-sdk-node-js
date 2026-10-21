# example-sdk-orders-and-reports

Read-only: list unshipped orders and fetch the Settlement Summary report for a date range.

## What it shows

- `orders.list({ status, page, pageSize })` — prints order number, status and item count only;
  the buyer's name, phone, e-mail and address are never printed.
- `reports.settlementSummary.waitForResult({ dateFrom, dateTo })` — submits the report, polls it to
  completion (Newegg can take about 3 minutes) and returns every row. A `ReportTimeoutError`
  carries the `requestId` so you can continue with `waitForRequest` instead of resubmitting.
- Handling `NeweggError` with its typed fields.

## Environment

Required: `NEWEGG_SELLER_ID`, `NEWEGG_API_KEY`, `NEWEGG_SECRET_KEY`, `NEWEGG_MARKETPLACE`, `NEWEGG_CREDENTIALS_MARKETPLACE` (the marketplace the keys were issued for; must equal `NEWEGG_MARKETPLACE`).
Optional: `EXAMPLE_SETTLEMENT_FROM` / `EXAMPLE_SETTLEMENT_TO` (`YYYY-MM-DD`, default last 30 days).

Credentials are read from the environment and never printed. See
[`.env.example`](../../.env.example).

## Run

```bash
NEWEGG_SELLER_ID=... NEWEGG_API_KEY=... NEWEGG_SECRET_KEY=... NEWEGG_MARKETPLACE=us \
  NEWEGG_CREDENTIALS_MARKETPLACE=us \
  npm run start -w example-sdk-orders-and-reports
```

## Writes

None. `orders.ship`, `cancel`, `confirmDownload` and `removeItems` are writes and are not used here.

## Typecheck

```bash
npm run typecheck -w example-sdk-orders-and-reports
```
