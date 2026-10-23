# ADR 0004 — Retry policy and indeterminate feed submissions

**Status**: accepted · 2026-07-10

## Context

Direct inventory updates are absolute assignments ("set quantity to N") — retrying an
identical request is safe. Feed submission is not: a timeout _after_ the request body may
have reached Newegg leaves the outcome unknown, and blind resubmission double-submits up
to 10,000 records and burns the 10/minute + 100k/hour budgets.

## Decision

Two retry policies:

1. **Direct operations** (reads, single-item writes, status/result queries): retry on
   network errors, HTTP 408/429/502/503/504, with full-jitter exponential backoff
   (default 3 attempts, base 250 ms, cap 10 s), honoring `X-RateLimit-ResetTime` and
   DF012 "submit again after" hints when present. Payload bytes are identical across
   attempts.
2. **Feed submission**: retryable only when provably unsent (DNS failure, connection
   refused, TLS failure before write) or definitively rejected (HTTP 4xx). Any
   ambiguous failure (timeout/abort/reset after send) throws
   `IndeterminateFeedSubmissionError` carrying: sha-256 `payloadHash` of the canonical
   feed body, `correlationId`, `marketplace`, `submittedAtIso`, and `guidance` text
   instructing callers to check recent feed status before resubmitting.

An injectable `OperationStore` records `{state: submitting|submitted|failed, payloadHash,
requestIds}` around every feed submission so distributed callers can build dedup ledgers;
`InMemoryOperationStore` ships for tests/single-process use.

## Addendum (2026-10-22, T-6212): label creates

The same ledger idea guards the non-idempotent shipping-label create, which spends money per call. The
SDK records a create in the `OperationStore` per (marketplace, order) before dispatch (`submitting`),
settles it `submitted` or `failed` (provably unsent) and leaves an indeterminate one at `submitting`;
a new create is refused while such a record is under 24 h old. A programmatic SDK caller may name the prior
attempt to clear it (not a human gate); the MCP offers no such argument, so an operator clears it by verifying
the order and restarting the server (contracts §23.5). Only an explicit failure frees the order: an HTTP 4xx is
treated as a rejection (contracts §23.6 item 11), anything unfamiliar stays `submitting`.

## Consequences

No silent double feeds; callers get a machine-usable recovery path; absolute-assignment
retries stay automatic and safe.

## Addendum (2026-10-22, T-6280): persistent label ledger

The label-create ledger no longer has to die with the process. `OperationStore` gains an optional
`compareAndPut(key, expected, op)`; the ledger re-reads the record right before its `submitting` write and,
when the store offers it, writes only if the record is unchanged, so two processes sharing a store cannot both
claim an order. The MCP server can keep its label-create records in a file
(`NEWEGG_MCP_OPERATION_STORE_FILE`: atomic writes, lock file, fails closed on a corrupt or unreadable file);
feed submission records stay in memory because they have no expiry. The block window is configurable
(`labelCreateGuardWindowMs`, `NEWEGG_MCP_LABEL_CREATE_GUARD_HOURS`, 1 hour to 30 days). Clearing a record is a
shell command for the operator (`--clear-label-guard`), never a tool, so an agent still cannot lift the guard.

Review fix (same task): the file store never takes over a lock automatically (a takeover window let two
processes both win); `--release-store-lock` is the operator's way to clear a crash leftover. The path must be
absolute and a lost file is detected from leftovers beside it.
