# Error handling

Every failure the SDK raises is a subclass of `NeweggError`, carries a stable machine-usable
`code`, a `retryable` flag, and a `correlationId` for tracing. This document maps the class
hierarchy, shows the upstream body shapes the SDK parses, details validation and rate-limit
errors, and gives the full recovery recipe for the one error you must never blindly retry:
`IndeterminateFeedSubmissionError`.

Names and fields come from `docs/research/sdk-public-api.md`; Newegg error codes and body
shapes come from `docs/research/newegg-api-contracts.md` (cited as §).

---

## The base class

```ts
class NeweggError extends Error {
  readonly code: NeweggErrorCode;
  readonly httpStatus?: number; // upstream HTTP status when there was one
  readonly neweggErrorCode?: string; // e.g. CT002, DF012, InvalidToken
  readonly neweggRequestId?: string; // feed request id when relevant
  readonly correlationId?: string; // ties the failure to your logs + Newegg
  readonly retryable: boolean; // whether a safe automatic retry is possible
  readonly details?: unknown; // sanitized, JSON-safe
}
```

`details` and every other field are **sanitized**: credential header values (`Authorization`,
`SecretKey`), `apiKey`, and `secretKey` never appear in an error, its `details`, or any
serialized form (behavioural requirement 7).

---

## Class hierarchy

| Class                                  | `code`                          | Typical trigger                                                                                                                                                                                 | `retryable`  |
| -------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `NeweggConfigurationError`             | `configuration`                 | Invalid client config caught in `createNeweggClient` (bad marketplace, missing key).                                                                                                            | no           |
| `NeweggValidationError`                | `validation`                    | Input failed a Zod `.strict()` schema (negative quantity, missing US `warehouseLocation`, Seller Part Number > 40 chars, unknown key, explicit `feed` with items lacking a Seller Part Number). | no           |
| `NeweggAuthenticationError`            | `authentication`                | `401` with `InvalidConsumerKey` / `InvalidToken`.                                                                                                                                               | no           |
| `NeweggAuthorizationError`             | `authorization`                 | `401` `Gateway: Seller Auth failed.`, or wrong-platform credentials (§9).                                                                                                                       | no           |
| `NeweggRateLimitError`                 | `rate_limit`                    | `429 Too many request.`, or feed hourly-allowance `DF012`.                                                                                                                                      | yes¹         |
| `NeweggApiError`                       | `api`                           | Other upstream API errors (`CT002`, `CE001`, `DF006`, malformed responses).                                                                                                                     | conditional² |
| `NeweggFeedSubmissionError`            | `feed_submission`               | Feed submission failed **definitively** — provably unsent, or a `4xx` rejection.                                                                                                                | conditional³ |
| `IndeterminateFeedSubmissionError`     | `feed_submission_indeterminate` | Feed submission failed **ambiguously** — timeout/abort/reset after the body may have reached Newegg.                                                                                            | **no**       |
| `NeweggFeedProcessingError`            | `feed_processing`               | The feed processed but Newegg reported record-level errors.                                                                                                                                     | no⁴          |
| `NeweggFeedCancelledError`             | `feed_cancelled`                | Feed reached `CANCELLED`.                                                                                                                                                                       | no           |
| `NeweggTimeoutError`                   | `timeout`                       | A direct request exceeded its timeout.                                                                                                                                                          | yes⁵         |
| `UnsupportedMarketplaceOperationError` | `unsupported_operation`         | Operation not available on the selected marketplace.                                                                                                                                            | no           |

1. Retry only after honouring the reset hint (see [Rate-limit errors](#rate-limit-errors)).
2. `408`/`502`/`503`/`504` are retried with backoff; other `4xx`/`5xx` are not (ADR 0004).
3. Safe to retry when _provably unsent_ (DNS/connection/TLS failure before write). A `4xx`
   definitive rejection re-sent unchanged will just be rejected again — fix the input first.
4. Record-level failures are fixed by correcting the offending records and resubmitting, not
   by a transport retry. Inspect `FeedResult.records`.
5. Direct reads and writes are absolute assignments, so a timeout is safe to retry. A feed
   _submission_ timeout is **never** a `NeweggTimeoutError` — it surfaces as
   `IndeterminateFeedSubmissionError` because the body may have landed.

---

## Upstream body shapes the SDK parses

Newegg is inconsistent about error encoding. The SDK's parser tolerates all of the following
and extracts `neweggErrorCode` + a human message from each (§1):

```jsonc
// 1. JSON array of { Code, Message } — the most common auth/throttle shape
[{ "Code": "InvalidConsumerKey", "Message": "The provided consumer key is malformed or otherwise invalid." }]
[{ "Code": "429", "Message": "Too many request." }]

// 2. Single JSON object
{ "Code": "CT002", "Message": "Invalid SellerPartNumber" }

// 3. JSON array (validation)
[{ "Code": "CE001", "Message": "SellerID cannot be null or empty" }]
```

```xml
<!-- 4. XML (returned when Accept handling falls back) -->
<?xml version="1.0"?>...<Code>DF006</Code>...
```

```text
5. Plain text (observed live on 401):
Gateway: Seller Auth failed.
```

Because shape 5 is plain text, the parser must never assume JSON. Whatever the shape, the
extracted Newegg code lands on `error.neweggErrorCode` and the raw upstream body is **not**
attached verbatim — `details` is sanitized and JSON-safe.

Frequently seen Newegg codes and where they land:

| Newegg code                           | Meaning                             | SDK class                                  |
| ------------------------------------- | ----------------------------------- | ------------------------------------------ |
| `InvalidConsumerKey`                  | Malformed/invalid API key           | `NeweggAuthenticationError`                |
| `InvalidToken`                        | Invalid secret key                  | `NeweggAuthenticationError`                |
| `Gateway: Seller Auth failed.` (text) | Credentials rejected by gateway     | `NeweggAuthorizationError`                 |
| `CE001`                               | SellerID null or empty              | `NeweggValidationError` / `NeweggApiError` |
| `CT002`                               | Invalid SellerPartNumber            | `NeweggApiError`                           |
| `429`                                 | Too many requests                   | `NeweggRateLimitError`                     |
| `DF012`                               | Feed hourly allowance exceeded      | `NeweggRateLimitError`                     |
| `DF006`                               | Invalid feed RequestID              | `NeweggApiError`                           |
| `DF003`                               | Feed status `MaxCount` cap (30,000) | `NeweggApiError`                           |

---

## Validation errors

`NeweggValidationError` adds a structured `issues` array so you can map a failure back to the
exact offending input row:

```ts
class NeweggValidationError extends NeweggError {
  readonly issues: Array<{ path: string; message: string; inputIndex?: number }>;
}
```

- `path` — dot/bracket path into the validated input, e.g. `updates[3].warehouseLocation`.
- `message` — the human-readable reason.
- `inputIndex` — index in the caller's original array (present for batch inputs), so a
  failure in `updateMany([...])` points at the precise element.

All public inputs are validated with Zod v4 `.strict()` schemas, so **unknown keys are
rejected** rather than ignored. Common triggers: quantity not a non-negative safe integer
(`0` is valid); US operation missing a `warehouseLocation` matching `/^[A-Z]{3}$/`; Seller
Part Number empty or longer than 40 characters; and — the one that catches people —
`strategy: "feed"` with items that have no Seller Part Number, which lists every offending
`inputIndex` instead of silently downgrading them.

---

## Rate-limit errors

```ts
class NeweggRateLimitError extends NeweggError {
  readonly rateLimit?: RateLimitInfo;
  readonly retryAfterMs?: number;
}
```

Two upstream triggers, both carrying reset hints (§3):

- **`429 Too many request.`** — per-seller, per-function, one-minute window. The
  `X-RateLimit-ResetTime` response header (Pacific Time) is normalized into
  `rateLimit.requestResetAt` and, where derivable, `retryAfterMs`.
- **`DF012`** — feed hourly allowance. The message embeds an explicit
  _"submit your feed again after `<Pacific-Time timestamp>`"_, which the SDK parses into
  `retryAfterMs`.

Newegg's diagnostic headers are normalized onto `RateLimitInfo`:

| Header                    | `RateLimitInfo` field     |
| ------------------------- | ------------------------- |
| `X-RateLimit-Limit`       | `requestLimit`            |
| `X-RateLimit-Remaining`   | `requestRemaining`        |
| `X-RateLimit-ResetTime`   | `requestResetAt` (`Date`) |
| `X-RecordCount-Limit`     | `recordLimit`             |
| `X-RecordCount-Remaining` | `recordRemaining`         |
| `X-RecordCount-ResetTime` | `recordResetAt` (`Date`)  |

`RateLimitInfo` is also attached to successful read/write/feed results (`result.rateLimit`),
so you can throttle proactively rather than waiting for a `429`.

---

## `IndeterminateFeedSubmissionError`: the recovery recipe

A feed submission that times out, aborts, or resets **after** the request body may have
reached Newegg has an unknown outcome. Blindly resubmitting risks a double-submit of up to
10,000 records and burns the 10/min + 100k/hour budgets (ADR 0004). So the SDK does **not**
auto-retry — it throws `IndeterminateFeedSubmissionError`:

```ts
class IndeterminateFeedSubmissionError extends NeweggError {
  readonly payloadHash: string; // sha-256 of the canonical feed body
  readonly marketplace: NeweggMarketplace;
  readonly submittedAtIso: string; // when the ambiguous send happened
  readonly guidance: string; // "check recent feed status before resubmitting…"
}
```

Recover deliberately:

```ts
import {
  IndeterminateFeedSubmissionError,
  type FeedRequestStatus,
} from "@devino/newegg-marketplace-sdk";

try {
  await client.inventory.updateMany(updates, { strategy: "feed" });
} catch (err) {
  if (!(err instanceof IndeterminateFeedSubmissionError)) throw err;

  // 1. Do NOT resubmit yet. The body may already be at Newegg.
  const { payloadHash, marketplace, submittedAtIso, correlationId } = err;

  // 2. Find candidate request IDs. An ambiguous send means the SDK never received a
  //    request ID for THIS attempt, so recover from state you persisted. The injectable
  //    OperationStore records { state, payloadHash, requestIds } around every submission;
  //    a ledger keyed by payloadHash lets distributed workers coordinate. If you kept no
  //    request IDs, reconcile via the Newegg Seller Portal using submittedAtIso.
  const candidateRequestIds = await myLedger.requestIdsFor(payloadHash); // your code

  // 3. Ask Newegg the status of each candidate. Feed status is queryable by request ID
  //    ONLY — date-range filters are not implemented (see platform-differences.md) — so
  //    you cannot "list feeds since submittedAtIso" through the SDK.
  const landedStatuses: FeedRequestStatus[] = ["SUBMITTED", "IN_PROGRESS", "FINISHED"];
  let landed = false;
  for (const requestId of candidateRequestIds) {
    const report = await client.feeds.getStatus(requestId);
    if (landedStatuses.includes(report.status)) {
      landed = true;
      // 4. It landed. Poll it instead of resubmitting.
      const outcome = await client.feeds.waitForResult(requestId);
      // handle outcome.result / outcome.outcome === "timeout" | "cancelled"
      break;
    }
  }

  // 5. Only when no matching feed exists after a reasonable settle window is it safe to
  //    resend the identical payload (same payloadHash → same canonical body).
  if (!landed) {
    await client.inventory.updateMany(updates, { strategy: "feed" });
  }

  // 6. Record the resolution in your OperationStore/ledger so a retry of this same
  //    operation elsewhere does not double-submit.
}
```

The `payloadHash` is stable across attempts because it is the sha-256 of the _canonical_
feed body, so it is the correct key for a dedup ledger. `InMemoryOperationStore` ships for
single-process/test use; provide your own `OperationStore` (get/put) for distributed
deployments.

---

## Correlation IDs

Every request accepts `RequestOptions.correlationId`; when omitted, the SDK generates a UUID.
The same value appears on:

- the `correlationId` field of every result (`InventoryItemSnapshot`, `InventoryUpdateResult`,
  `FeedSubmission`, …),
- `error.correlationId` on any thrown `NeweggError`, and
- every structured log line for that operation.

Pass your own to stitch SDK activity into an existing trace:

```ts
await client.inventory.updateMany(updates, { correlationId: myTraceId });
```

---

## Logging and redaction guarantees

Provide a `NeweggLogger` (`debug`/`info`/`warn`/`error`, each `(event, fields?)`) to receive
structured events. The SDK emits these `event` names:

`request_started`, `request_completed`, `retry_scheduled`, `rate_limit_wait`,
`feed_submitted`, `feed_status_changed`, `feed_processing_completed`, `partial_failure`,
`indeterminate_submission`.

`fields` always include `correlationId`, `operation`, and `marketplace`, plus `durationMs`
where relevant and `sellerIdHash` — a sha-256 prefix of the seller ID, **never the raw
seller ID**.

Redaction is guaranteed (behavioural requirement 7): `Authorization`/`SecretKey` header
values, `apiKey`, and `secretKey` never appear in errors, logs, `raw` payloads, or any
serialized output. The optional `raw` payload on results (only present when
`RequestOptions.includeRaw` is set, and never exposed through the MCP server) is sanitized —
request/response headers are stripped before it is attached.
