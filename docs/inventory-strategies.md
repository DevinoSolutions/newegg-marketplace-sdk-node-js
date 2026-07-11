# Inventory update strategies

How `@devino/newegg-marketplace-sdk` turns a list of desired inventory levels into the
smallest correct set of Newegg calls: when it updates items one at a time (**direct**),
when it batches them into asynchronous **feed** files, how it deduplicates conflicting
updates, and how it reports exactly what happened per item.

Every name, option, and default in this document is taken from the binding SDK API
contract (`docs/research/sdk-public-api.md`) and the verified Newegg wire contracts
(`docs/research/newegg-api-contracts.md`). Newegg-side limits are cited to sections of the
latter.

---

## The three strategies

`inventory.updateMany(updates, options)` accepts `options.strategy`:

| Strategy   | Behaviour                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"direct"` | One HTTP write per item against the platform's direct inventory endpoint, with bounded concurrency (`options.concurrency`, default **4**). Synchronous: each item resolves to a final outcome before the call returns. |
| `"feed"`   | Serialize all items into one or more asynchronous feed files, submit them, and (optionally) wait for processing. Acceptance of a feed is **not** per-item success.                                                     |
| `"auto"`   | **Default.** Choose direct or feed automatically from the post-deduplication item count.                                                                                                                               |

`inventory.updateItem(update, options)` is always a single direct write; it never escalates
to a feed.

### How `"auto"` decides

After validation and deduplication, `"auto"` compares the surviving item count to
`autoFeedThreshold`:

```ts
const client = createNeweggClient({
  sellerId: process.env.NEWEGG_SELLER_ID!,
  apiKey: process.env.NEWEGG_API_KEY!,
  secretKey: process.env.NEWEGG_SECRET_KEY!,
  marketplace: "us",
  strategy: {
    // updateMany "auto" switches to feeds above this many post-dedup items.
    // Default 8. This is an SDK policy, NOT a Newegg rule.
    autoFeedThreshold: 8,
  },
});
```

- **post-dedup count ≤ `autoFeedThreshold`** → direct updates with bounded concurrency.
- **post-dedup count > `autoFeedThreshold`** → feed submission(s).

The default threshold of **8** is a deliberate SDK policy, not a Newegg limit — small
updates stay synchronous and cheap; large updates use the feed pipeline that Newegg meters
for bulk work. Tune it with `NeweggClientConfig.strategy.autoFeedThreshold`.

### Identifier requirements and fallbacks

Feeds require a **Seller Part Number** for every item (Newegg's feed envelope keys records
by `SellerPartNumber`; see `newegg-api-contracts.md` §7.1–§7.2). Direct updates also accept
a Newegg item number or a UPC.

- Under `"auto"`, any item whose `identifier.type` is not `"sellerPartNumber"` **falls back
  to a direct update** even when the batch is large enough to feed; the rest still feed. The
  resulting `InventoryUpdateResult.strategy` is then `"mixed"`.
- Under explicit `"feed"`, an item lacking a Seller Part Number is a hard error: the SDK
  throws `NeweggValidationError` listing every offending `inputIndex`. **Nothing is ever
  silently dropped.**

---

## Deduplication (last write wins)

Before anything is sent, `updateMany`/`previewUpdate` collapse updates that target the same
logical item so Newegg is never asked to set two quantities for one destination in a single
operation.

The dedup key is:

```
(marketplace, identifier.type + identifier.value, warehouseLocation ?? "")
```

When two updates share a key, the **last one in the caller's input array wins** (it is the
most recent intent), and the earlier ones are dropped. The drop is always reported — never
hidden.

### Worked example

Caller input to `updateMany` (marketplace `us`):

| `inputIndex` | identifier                  | warehouse | quantity |
| ------------ | --------------------------- | --------- | -------- |
| 0            | `sellerPartNumber: "SKU-A"` | `USA`     | 5        |
| 1            | `sellerPartNumber: "SKU-B"` | `USA`     | 3        |
| 2            | `sellerPartNumber: "SKU-A"` | `USA`     | 12       |

Indexes 0 and 2 share the key `(us, sellerPartNumber:SKU-A, USA)`. Index 2 is later, so it
wins; index 0 is dropped. The resulting preview/result reports:

```jsonc
{
  "normalizedUpdates": [
    {
      "inputIndex": 1,
      "identifier": { "type": "sellerPartNumber", "value": "SKU-B" },
      "warehouseLocation": "USA",
      "quantity": 3,
    },
    {
      "inputIndex": 2,
      "identifier": { "type": "sellerPartNumber", "value": "SKU-A" },
      "warehouseLocation": "USA",
      "quantity": 12,
    },
  ],
  "deduplicated": [{ "keptInputIndex": 2, "droppedInputIndexes": [0] }],
  "deduplicatedItemCount": 1,
}
```

Note that `USA` and an unset warehouse are different keys (`""` vs `"USA"`), and that the
same Seller Part Number in two different warehouses is **not** a duplicate — each
`(item, warehouse)` pair is updated independently.

---

## Chunking and Newegg budgets

### Feed file size

A single feed file carries at most **10,000 records** (`newegg-api-contracts.md` §7.4). The
SDK splits larger operations into stable, in-input-order chunks and submits one feed per
chunk. The math is a plain ceiling division:

| Post-dedup records | Feed files | Split                   |
| ------------------ | ---------- | ----------------------- |
| 10,000             | 1          | 10,000                  |
| **10,001**         | **2**      | 10,000 + 1              |
| 25,000             | 3          | 10,000 + 10,000 + 5,000 |

Each chunk gets its own Newegg `requestId`, and every accepted input item is mapped to the
feed that carried it via `FeedSubmission.itemAssignments` / `FeedJobSummary`, so you can
always trace an input row to its feed.

### Rate and volume budgets

| Operation               | Newegg budget (cited)                                     | Where enforced                                |
| ----------------------- | --------------------------------------------------------- | --------------------------------------------- |
| Direct inventory writes | 10,000 requests/hour (§6.1)                               | server-side; SDK surfaces `RateLimitInfo`     |
| Feed submissions        | 10 submissions/minute (§7.4)                              | local `RateLimitStore` budget + server-side   |
| Feed records            | 100,000 inventory records/hour (§7.4)                     | local `RateLimitStore` budget + server-side   |
| Batch reads (`getMany`) | chunked at 100 identifiers/request (§5.3, **assumption**) | SDK constant `GET_BATCH_INVENTORY_MAX_VALUES` |

The SDK's `RateLimitStore` locally budgets feed submissions at **10/min and 100,000
records/hour** per `${marketplace}:${sellerId}` and feeds observed response headers
(`X-RateLimit-*`, `X-RecordCount-*`) back into the limiter. When a limit is nonetheless hit,
Newegg answers `429` (or feed code `DF012` for the hourly allowance) and the SDK raises
`NeweggRateLimitError` with reset hints — see `error-handling.md`.

---

## Waiting for feed results

Feed processing is asynchronous. `updateMany` with `strategy: "feed"` (or `"auto"` that
chose feeds) does not wait unless you ask it to:

```ts
const result = await client.inventory.updateMany(updates, {
  strategy: "feed",
  waitForFeedCompletion: true,
  wait: {
    pollingIntervalMs: 5_000, // first poll delay; default 5_000
    maxPollingIntervalMs: 60_000, // ceiling for the backoff; default 60_000
    timeoutMs: 900_000, // hard stop; default 900_000 (15 min)
  },
});
```

You can also poll a single feed directly:

```ts
const outcome = await client.feeds.waitForResult(requestId, { timeoutMs: 600_000 });
```

### The polling curve

`waitForResult` uses **bounded exponential** backoff: it waits `pollingIntervalMs`, then
doubles each interval up to `maxPollingIntervalMs`, re-checking `feeds.getStatus` until the
feed reaches `FINISHED`/`CANCELLED` or the total elapsed time exceeds `timeoutMs`. With the
defaults, the poll schedule is:

| Poll | Wait before poll | Cumulative elapsed |
| ---- | ---------------- | ------------------ |
| 1    | 5 s              | 5 s                |
| 2    | 10 s             | 15 s               |
| 3    | 20 s             | 35 s               |
| 4    | 40 s             | 75 s               |
| 5    | 60 s (capped)    | 135 s              |
| 6+   | 60 s each        | … up to 900 s      |

Polling honours an `AbortSignal` and never runs unbounded.

### Timeout is an outcome, not an error

`waitForResult` returns a `FeedWaitOutcome` — a discriminated union — rather than throwing
on slow feeds:

```ts
type FeedWaitOutcome =
  | { outcome: "finished"; result: FeedResult }
  | { outcome: "cancelled"; requestId: string; status: "CANCELLED" }
  | { outcome: "timeout"; requestId: string; lastStatus: FeedRequestStatus; elapsedMs: number };
```

A `"timeout"` outcome **preserves the `requestId`** and the `lastStatus` observed, so you
can persist it and resume later with another `waitForResult(requestId)` or a direct
`feeds.getResult(requestId)` — the work is not lost. Only genuine cancellation
(`FeedRequestStatus === "CANCELLED"`) yields the `"cancelled"` outcome.

---

## Reading the result of a write

`updateItem` and `updateMany` both resolve to an `InventoryUpdateResult`:

```ts
interface InventoryUpdateResult {
  operationId: string;
  correlationId: string;
  marketplace: NeweggMarketplace;
  strategy: "direct" | "feed" | "mixed";
  submittedItemCount: number;
  acceptedItemCount: number;
  failedItemCount: number;
  deduplicatedItemCount: number;
  feedJobs?: FeedJobSummary[]; // present when any feed was submitted
  items: ItemOutcome[]; // one entry per post-dedup item
  warnings: string[];
  rateLimit?: RateLimitInfo;
  raw?: unknown; // only when RequestOptions.includeRaw is set
}
```

### Per-item outcomes

Each `ItemOutcome` ties a result back to the caller's original row via `inputIndex`:

```ts
interface ItemOutcome {
  inputIndex: number;
  sellerPartNumber?: string;
  warehouseLocation?: string;
  quantity: number;
  status: ItemOutcomeStatus;
  errorCode?: string; // Newegg error code when failed/warning
  message?: string;
}
```

`ItemOutcomeStatus` values, and when you see each:

| Status      | Meaning                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `planned`   | Validated, deduplicated, and scheduled, but not yet transmitted.                                                     |
| `submitted` | Accepted into a feed submission; the final per-item outcome is still pending (feed processing, or you did not wait). |
| `succeeded` | Newegg confirmed the update was applied.                                                                             |
| `warning`   | Applied, but Newegg attached a non-fatal warning (`message`/`errorCode` explain).                                    |
| `failed`    | Newegg rejected this item (`errorCode`/`message` explain).                                                           |
| `unknown`   | Outcome could not be determined — most often a feed record Newegg did not individually report.                       |

The `unknown` status is a direct consequence of Newegg's feed-result semantics: the
processing report details records **with errors or warnings**, and successful records
generally get no `Result` entry (`newegg-api-contracts.md` §7.6). Per-record success is
therefore inferred from the summary counts; where the SDK cannot attribute an outcome to a
specific record with confidence, it reports `unknown` rather than guessing `succeeded`.
This is why **submission acceptance is not the same as item success** — always inspect
`items`, not just `acceptedItemCount`.

---

## Preview before you write

`previewUpdate` runs the entire validate → dedup → strategy-selection pipeline and returns
the plan **without performing any write**. It is the SDK-level equivalent of the MCP
preview→apply flow (`docs/mcp-security.md`), and the recommended pattern for any
consequential update.

```ts
const preview = await client.inventory.previewUpdate(updates, {
  strategy: "auto",
  includeCurrentInventory: true, // performs reads only; still zero writes
});

// Inspect before committing:
preview.strategy; // "direct" | "feed" | "mixed"
preview.normalizedUpdates; // exactly what will be sent, in send order
preview.deduplicated; // which inputs were collapsed
preview.plannedFeedCount; // 0 when direct
preview.zeroQuantityCount; // how many items would be set to 0
preview.warnings; // e.g. UPC/newegg-number items forced to direct
preview.currentInventory; // present when includeCurrentInventory

// Commit the exact normalized plan:
const result = await client.inventory.updateMany(preview.normalizedUpdates, {
  strategy: "auto",
  waitForFeedCompletion: true,
});
```

Because `NormalizedInventoryUpdate extends InventoryUpdate`, `preview.normalizedUpdates`
can be handed straight back to `updateMany`. Passing the normalized set re-runs validation
(cheap and idempotent) over an already-clean plan, so what you reviewed is what you send.

Pay particular attention to `zeroQuantityCount`: a quantity of `0` is valid and meaningful
(it sets the item to out-of-stock), which is exactly why it is surfaced separately for
review.
