# ADR 0003 — Direct vs feed update strategy

**Status**: accepted · 2026-07-10

## Context

Direct endpoints update one item per request (10,000 req/hour budget); data feeds carry
up to 10,000 records per file but are asynchronous (submit → poll status → fetch result)
and budgeted at 10 submissions/minute and 100,000 records/hour. Feeds require a
SellerPartNumber; direct updates accept Newegg item number or UPC too.

## Decision

`strategy: "direct" | "feed" | "auto"` on `updateMany` (default `auto`).

- `auto`: after validation + dedup, ≤ `autoFeedThreshold` items (default **8** — an SDK
  policy, not a Newegg rule; configurable via `NeweggClientConfig.strategy`) → direct
  updates with bounded concurrency; more → feed(s). Items without a SellerPartNumber
  fall back to direct.
- explicit `feed` with items lacking SellerPartNumber → `NeweggValidationError` listing
  the offending input indexes. Nothing is silently dropped, ever.
- Dedup before submission: **last write wins** on
  `(marketplace, identifier, warehouseLocation ?? "")`; dropped indexes are reported in
  previews and results (`deduplicatedItemCount`, `deduplicated[]`).
- Chunking: stable input order, 10,000 records per feed, per-chunk Newegg request IDs,
  every accepted input index mapped to its feed via `itemAssignments`.

## Consequences

Small updates stay synchronous and cheap; large updates respect Newegg's documented
limits; callers can always force a mode and get deterministic, fully-attributed results.
