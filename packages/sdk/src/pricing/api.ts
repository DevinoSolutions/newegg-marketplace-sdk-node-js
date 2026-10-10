import { randomUUID } from "node:crypto";
import type {
  GetPriceInput,
  GetPriceManyInput,
  GetPriceManyOptions,
  ItemIdentifier,
  ItemPriceSnapshot,
  NormalizedPriceUpdate,
  PreviewPriceOptions,
  PriceBatchSnapshot,
  PriceChange,
  PriceEntry,
  PriceOutcomeStatus,
  PriceReadFailure,
  PriceUpdate,
  PriceUpdateOutcome,
  PriceUpdatePreview,
  PriceUpdateResult,
  PricingApi,
  RequestOptions,
  UpdatePricesOptions,
} from "../types.js";
import type { ParsedPrice } from "../platform/index.js";
import type { HttpResult, NeweggHttpClient } from "../client/http.js";
import {
  NeweggApiError,
  NeweggAuthenticationError,
  NeweggAuthorizationError,
  NeweggError,
  NeweggRateLimitError,
  NeweggTimeoutError,
} from "../errors/index.js";
import { Operation } from "../client/operations.js";
import { parseOrThrow } from "../inventory/validate.js";
import { LogEvent } from "../logging/index.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { getPriceInputSchema, getPriceManyInputSchema } from "../schemas/inputs.js";
import { isAbortError, isRecord, mapWithConcurrency } from "../util.js";
import {
  DEFAULT_PRICE_READ_CONCURRENCY,
  DEFAULT_PRICE_WRITE_CONCURRENCY,
  INFERRED_CURRENCY,
  PRICE_COMPARE_EPSILON,
  PRICE_NOT_FOUND_ERROR_CODES,
} from "./constants.js";
import { dedupePriceUpdates, validatePriceUpdates } from "./validate.js";

/** HTTP statuses that leave a write's outcome unknown (it may have been applied). */
const AMBIGUOUS_HTTP_STATUSES = new Set([408, 502, 503, 504]);
/** Network error codes that prove the request never left the machine. */
const PRE_SEND_CAUSE_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"]);

/**
 * Whether a write that failed (after the HTTP core's retries) may nevertheless have been
 * applied: a timeout, a 408/502/503/504, or a network error that is not provably pre-send.
 */
function isAmbiguousFailure(error: NeweggError): boolean {
  if (error instanceof NeweggTimeoutError) return true;
  if (error.httpStatus !== undefined) return AMBIGUOUS_HTTP_STATUSES.has(error.httpStatus);
  if (error.retryable && error.code === "api") {
    const causeCode = isRecord(error.details) ? error.details.causeCode : undefined;
    return !(typeof causeCode === "string" && PRE_SEND_CAUSE_CODES.has(causeCode));
  }
  return false;
}

function identifierKey(identifier: ItemIdentifier): string {
  const condition = identifier.type === "upc" ? (identifier.condition ?? "") : "";
  return JSON.stringify([identifier.type, identifier.value, condition]);
}

/** Errors that affect every read in a batch (bad credentials, exhausted budget): never swallowed. */
function isBatchFatal(error: unknown): boolean {
  return (
    isAbortError(error) ||
    error instanceof NeweggAuthenticationError ||
    error instanceof NeweggAuthorizationError ||
    error instanceof NeweggRateLimitError
  );
}

type ReadOutcome =
  | { kind: "ok"; snapshot: ItemPriceSnapshot; raw?: unknown }
  | { kind: "missing" }
  | { kind: "failed"; failure: Omit<PriceReadFailure, "identifier"> };

/**
 * Pricing API. Reads (`get`/`tryGet`/`getMany`) are Get Item Price, which the docs classify as a
 * read on all three platforms even though US sends it as `PUT` and B2B/CAN as `POST`
 * (contracts §15). `previewUpdate` only reads. `update` is the ONLY write: it assigns absolute
 * selling prices through the adapter's `priceUpdateRequest` (contracts §16) and nothing else.
 */
export class PricingApiImpl implements PricingApi {
  readonly #http: NeweggHttpClient;

  constructor(http: NeweggHttpClient) {
    this.#http = http;
  }

  get #config() {
    return this.#http.config;
  }

  #entries(parsed: ParsedPrice): PriceEntry[] {
    const inferred = INFERRED_CURRENCY[this.#config.marketplace];
    return parsed.entries.map((entry) => {
      const wireCurrency = entry.currency;
      const out: PriceEntry = {
        currency: wireCurrency ?? inferred,
        currencyInferred: wireCurrency === undefined && inferred !== undefined,
        promotions: entry.promotions,
      };
      if (entry.countryCode !== undefined) out.countryCode = entry.countryCode;
      if (entry.active !== undefined) out.active = entry.active;
      if (entry.msrp !== undefined) out.msrp = entry.msrp;
      if (entry.map !== undefined) out.map = entry.map;
      if (entry.checkoutMap !== undefined) out.checkoutMap = entry.checkoutMap;
      if (entry.sellingPrice !== undefined) out.sellingPrice = entry.sellingPrice;
      if (entry.freeShipping !== undefined) out.freeShipping = entry.freeShipping;
      if (entry.limitQuantity !== undefined) out.limitQuantity = entry.limitQuantity;
      return out;
    });
  }

  async get(input: GetPriceInput, options: RequestOptions = {}): Promise<ItemPriceSnapshot> {
    const validated = parseOrThrow(
      getPriceInputSchema,
      input,
      "pricing.get input validation failed.",
    );
    const correlationId = options.correlationId ?? randomUUID();
    return this.#read(validated.identifier, validated.countries, correlationId, options);
  }

  async tryGet(
    input: GetPriceInput,
    options: RequestOptions = {},
  ): Promise<ItemPriceSnapshot | undefined> {
    try {
      return await this.get(input, options);
    } catch (err) {
      if (
        err instanceof NeweggApiError &&
        err.neweggErrorCode !== undefined &&
        PRICE_NOT_FOUND_ERROR_CODES.has(err.neweggErrorCode)
      ) {
        return undefined;
      }
      throw err;
    }
  }

  async #read(
    identifier: ItemIdentifier,
    countries: string[] | undefined,
    correlationId: string,
    options: RequestOptions,
  ): Promise<ItemPriceSnapshot> {
    const { marketplace, sellerId } = this.#config;
    // Country filtering exists on the US endpoint only; B2B/CAN is single-market.
    const spec = this.#http.adapter.getPriceRequest(
      identifier,
      marketplace === "us" ? countries : undefined,
    );
    const result = await this.#http.request(spec, {
      operation: Operation.PriceGet,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.PriceGet),
    });
    const parsed = this.#http.adapter.parsePrice(result.json);
    if (!parsed) {
      throw new NeweggApiError("Newegg returned no price for the requested item.", {
        correlationId,
        httpStatus: result.status,
      });
    }
    const snapshot: ItemPriceSnapshot = {
      marketplace,
      itemNumber: parsed.itemNumber,
      sellerPartNumber: parsed.sellerPartNumber,
      prices: this.#entries(parsed),
      correlationId,
      rateLimit: result.rateLimit,
    };
    if (parsed.shippedByNewegg !== undefined) snapshot.shippedByNewegg = parsed.shippedByNewegg;
    if (options.includeRaw) snapshot.raw = result.json;
    return snapshot;
  }

  async getMany(
    input: GetPriceManyInput,
    options: GetPriceManyOptions = {},
  ): Promise<PriceBatchSnapshot> {
    const validated = parseOrThrow(
      getPriceManyInputSchema,
      input,
      "pricing.getMany input validation failed.",
    );
    const correlationId = options.correlationId ?? randomUUID();
    const { marketplace } = this.#config;

    const seen = new Set<string>();
    const identifiers: ItemIdentifier[] = [];
    for (const identifier of validated.identifiers) {
      const key = identifierKey(identifier);
      if (seen.has(key)) continue;
      seen.add(key);
      identifiers.push(identifier);
    }

    const outcomes = await mapWithConcurrency(
      identifiers,
      options.concurrency ?? DEFAULT_PRICE_READ_CONCURRENCY,
      async (identifier): Promise<ReadOutcome> => {
        try {
          const snapshot = await this.#read(identifier, validated.countries, correlationId, {
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            includeRaw: options.includeRaw,
          });
          return { kind: "ok", snapshot };
        } catch (err) {
          if (isBatchFatal(err)) throw err;
          if (
            err instanceof NeweggApiError &&
            err.neweggErrorCode !== undefined &&
            PRICE_NOT_FOUND_ERROR_CODES.has(err.neweggErrorCode)
          ) {
            return { kind: "missing" };
          }
          const error =
            err instanceof NeweggError
              ? err
              : new NeweggApiError("Price read failed.", { correlationId });
          return {
            kind: "failed",
            failure: {
              errorCode: error.neweggErrorCode,
              httpStatus: error.httpStatus,
              message: error.message,
            },
          };
        }
      },
    );

    const items: ItemPriceSnapshot[] = [];
    const missingIdentifiers: ItemIdentifier[] = [];
    const failures: PriceReadFailure[] = [];
    const rawResponses: unknown[] = [];
    let rateLimit: PriceBatchSnapshot["rateLimit"];
    outcomes.forEach((outcome, index) => {
      const identifier = identifiers[index] as ItemIdentifier;
      if (outcome.kind === "ok") {
        items.push(outcome.snapshot);
        rateLimit = outcome.snapshot.rateLimit ?? rateLimit;
        if (options.includeRaw) rawResponses.push(outcome.snapshot.raw);
      } else if (outcome.kind === "missing") {
        missingIdentifiers.push(identifier);
      } else {
        failures.push({ identifier, ...outcome.failure });
      }
    });

    const bySellerPartNumber = new Map<string, ItemPriceSnapshot>();
    const byItemNumber = new Map<string, ItemPriceSnapshot>();
    for (const snapshot of items) {
      if (snapshot.sellerPartNumber !== undefined) {
        bySellerPartNumber.set(snapshot.sellerPartNumber, snapshot);
      }
      if (snapshot.itemNumber !== undefined) byItemNumber.set(snapshot.itemNumber, snapshot);
    }

    return {
      marketplace,
      items,
      bySellerPartNumber,
      byItemNumber,
      missingIdentifiers,
      failures,
      totalCount: items.length,
      correlationId,
      rateLimit,
      raw: options.includeRaw ? rawResponses : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // writes (contracts §16)
  // -------------------------------------------------------------------------

  /** Reads one update's market (US: the country row) back as a normalized entry, if present. */
  async #readEntry(
    update: NormalizedPriceUpdate,
    correlationId: string,
    options: RequestOptions,
  ): Promise<PriceEntry | undefined> {
    const countries = update.countryCode === undefined ? undefined : [update.countryCode];
    const snapshot = await this.#read(update.identifier, countries, correlationId, options);
    return this.#config.marketplace === "us"
      ? snapshot.prices.find((price) => price.countryCode === update.countryCode)
      : snapshot.prices[0];
  }

  async previewUpdate(
    updatesInput: PriceUpdate | PriceUpdate[],
    options: PreviewPriceOptions = {},
  ): Promise<PriceUpdatePreview> {
    const updates = Array.isArray(updatesInput) ? updatesInput : [updatesInput];
    const { marketplace } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const normalized = validatePriceUpdates(updates, marketplace);
    const dedup = dedupePriceUpdates(normalized);
    const includeCurrent = options.includeCurrentPrice ?? true;

    const changes = await mapWithConcurrency(
      dedup.deduped,
      DEFAULT_PRICE_READ_CONCURRENCY,
      (update) =>
        this.#assess(update, includeCurrent, correlationId, {
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        }),
    );

    const warnings: string[] = [];
    if (marketplace === "us") {
      warnings.push(
        "US price writes follow the documented wire shape but have not been verified against a " +
          "live account (contracts §16); only SellingPrice is sent, other fields are assumed to " +
          "stay unchanged.",
      );
    }
    if (dedup.deduplicatedItemCount > 0) {
      warnings.push(
        `${dedup.deduplicatedItemCount} duplicate update(s) were removed (last-write-wins).`,
      );
    }
    const blocked = changes.filter((change) => change.status === "blocked").length;
    if (blocked > 0) {
      warnings.push(
        `${blocked} update(s) are blocked and must not be applied (see their blockers).`,
      );
    }
    if (!includeCurrent) {
      warnings.push("Current prices were not read; no blocker or warning checks were performed.");
    }

    return {
      marketplace,
      normalizedUpdates: dedup.deduped,
      deduplicated: dedup.report,
      changes,
      warnings,
      correlationId,
    };
  }

  async #assess(
    update: NormalizedPriceUpdate,
    includeCurrent: boolean,
    correlationId: string,
    options: RequestOptions,
  ): Promise<PriceChange> {
    const change: PriceChange = {
      inputIndex: update.inputIndex,
      identifier: update.identifier,
      newSellingPrice: update.sellingPrice,
      promotions: [],
      status: "unchecked",
      blockers: [],
      warnings: [],
    };
    if (update.countryCode !== undefined) change.countryCode = update.countryCode;
    if (update.currency !== undefined) change.currency = update.currency;
    if (!includeCurrent) return change;

    let entry: PriceEntry | undefined;
    try {
      entry = await this.#readEntry(update, correlationId, options);
    } catch (err) {
      if (isBatchFatal(err)) throw err;
      if (
        err instanceof NeweggApiError &&
        err.neweggErrorCode !== undefined &&
        PRICE_NOT_FOUND_ERROR_CODES.has(err.neweggErrorCode)
      ) {
        change.blockers.push("Newegg does not know this item for this seller (not found).");
      } else {
        const detail = err instanceof NeweggError ? err.message : "unexpected error";
        const code = err instanceof NeweggError ? err.neweggErrorCode : undefined;
        change.blockers.push(
          `The current price could not be read${code ? ` (${code})` : ""}: ${detail}`,
        );
      }
      change.status = "blocked";
      return change;
    }

    if (entry === undefined) {
      change.blockers.push(
        update.countryCode === undefined
          ? "Newegg returned no price record for this item."
          : `Newegg returned no price row for country ${update.countryCode} ` +
              "(the item may not be sold there).",
      );
      change.status = "blocked";
      return change;
    }

    change.active = entry.active;
    change.map = entry.map;
    change.msrp = entry.msrp;
    change.checkoutMap = entry.checkoutMap;
    change.promotions = entry.promotions;
    change.currentSellingPrice = entry.sellingPrice;
    if (change.currency === undefined) change.currency = entry.currency;
    const current = entry.sellingPrice;
    if (current !== undefined && current > 0) {
      change.changePercent = Math.round(((update.sellingPrice - current) / current) * 10_000) / 100;
    }

    if (
      update.currency !== undefined &&
      entry.currency !== undefined &&
      entry.currency !== update.currency
    ) {
      change.blockers.push(
        `Currency ${update.currency} does not match the item's current ${entry.currency} for ` +
          `${update.countryCode ?? "this market"} (Newegg rejects it with CT075).`,
      );
    }
    if (entry.msrp !== undefined && entry.msrp > 0 && update.sellingPrice > entry.msrp) {
      change.blockers.push(
        `The new price ${update.sellingPrice} exceeds the item's MSRP ${entry.msrp} ` +
          "(Newegg rejects it with CT029).",
      );
    }

    if (current !== undefined && Math.abs(current - update.sellingPrice) < PRICE_COMPARE_EPSILON) {
      change.warnings.push("The new price equals the current price (no change).");
    }
    if (entry.active === false) {
      change.warnings.push(
        "The item is inactive: Newegg disregards price updates to deactivated items while still " +
          "reporting success (contracts §6.2); the read-back will show the old price.",
      );
    }
    if (entry.promotions.length > 0) {
      change.warnings.push(
        `Active promotion(s) ${entry.promotions.join(", ")}: items locked for a Newegg promotion ` +
          "reject price changes (CT019).",
      );
    }
    if (
      entry.map !== undefined &&
      entry.map > 0 &&
      entry.checkoutMap !== true &&
      update.sellingPrice < entry.map
    ) {
      change.warnings.push(
        `The new price is below the MAP ${entry.map}: shoppers must add the item to the cart to ` +
          "see the price.",
      );
    }

    change.status =
      change.blockers.length > 0 ? "blocked" : change.warnings.length > 0 ? "warning" : "ok";
    return change;
  }

  async update(
    updatesInput: PriceUpdate | PriceUpdate[],
    options: UpdatePricesOptions = {},
  ): Promise<PriceUpdateResult> {
    const updates = Array.isArray(updatesInput) ? updatesInput : [updatesInput];
    const { marketplace } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const operationId = randomUUID();
    const normalized = validatePriceUpdates(updates, marketplace);
    const dedup = dedupePriceUpdates(normalized);
    const verify = options.verify ?? true;

    let rateLimit: PriceUpdateResult["rateLimit"];
    const items = await mapWithConcurrency(
      dedup.deduped,
      options.concurrency ?? DEFAULT_PRICE_WRITE_CONCURRENCY,
      async (update) => {
        const written = await this.#writeOne(update, verify, correlationId, options);
        rateLimit = written.rateLimit ?? rateLimit;
        return written.outcome;
      },
    );

    const count = (...statuses: PriceOutcomeStatus[]): number =>
      items.filter((item) => statuses.includes(item.status)).length;
    const failedItemCount = count("failed");
    const unresolvedItemCount = count("unverified", "unknown");
    if (failedItemCount + unresolvedItemCount > 0) {
      this.#config.logger.warn(LogEvent.PartialFailure, {
        correlationId,
        operation: "pricing.update",
        marketplace,
        sellerIdHash: this.#http.sellerIdHash,
        failedItemCount,
        unresolvedItemCount,
      });
    }

    const warnings: string[] = [];
    if (unresolvedItemCount > 0) {
      warnings.push(
        `${unresolvedItemCount} price(s) are unresolved (unverified/unknown): re-read them ` +
          "(pricing.get) before trusting or retrying.",
      );
    }
    return {
      operationId,
      correlationId,
      marketplace,
      submittedItemCount: dedup.deduped.length,
      appliedItemCount: count("verified", "accepted"),
      failedItemCount,
      unresolvedItemCount,
      deduplicatedItemCount: dedup.deduplicatedItemCount,
      items,
      warnings,
      rateLimit,
    };
  }

  /** One price WRITE plus its (optional) read-back. Never throws except on caller aborts. */
  async #writeOne(
    update: NormalizedPriceUpdate,
    verify: boolean,
    correlationId: string,
    options: UpdatePricesOptions,
  ): Promise<{ outcome: PriceUpdateOutcome; rateLimit?: PriceUpdateResult["rateLimit"] }> {
    const { marketplace, sellerId } = this.#config;
    const base = {
      inputIndex: update.inputIndex,
      identifier: update.identifier,
      requestedSellingPrice: update.sellingPrice,
      ...(update.countryCode === undefined ? {} : { countryCode: update.countryCode }),
    };
    const readOptions: RequestOptions = { signal: options.signal, timeoutMs: options.timeoutMs };

    const readBack = async (): Promise<number | undefined> =>
      (await this.#readEntry(update, correlationId, readOptions))?.sellingPrice;
    const matches = (observed: number | undefined): boolean =>
      observed !== undefined && Math.abs(observed - update.sellingPrice) < PRICE_COMPARE_EPSILON;

    const spec = this.#http.adapter.priceUpdateRequest(update);
    let result: HttpResult;
    try {
      // Absolute assignment => idempotent => the direct-operation retry policy applies (ADR 0004).
      result = await this.#http.request(spec, {
        operation: Operation.PriceUpdate,
        correlationId,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.PriceUpdate),
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      const error =
        err instanceof NeweggError
          ? err
          : new NeweggApiError("Price update failed.", { correlationId });
      if (!isAmbiguousFailure(error)) {
        return {
          outcome: {
            ...base,
            status: "failed",
            errorCode: error.neweggErrorCode,
            message: error.message,
          },
        };
      }
      // The write may have landed. Resolve it by reading the price back when allowed.
      if (verify) {
        try {
          const observed = await readBack();
          if (matches(observed)) {
            return {
              outcome: {
                ...base,
                status: "verified",
                observedSellingPrice: observed,
                message: "The write errored ambiguously but the read-back shows the new price.",
              },
            };
          }
        } catch (readErr) {
          if (isAbortError(readErr)) throw readErr;
        }
      }
      return {
        outcome: {
          ...base,
          status: "unknown",
          errorCode: error.neweggErrorCode,
          message:
            `${error.message} The price may or may not have been changed; re-read it ` +
            "before retrying.",
        },
      };
    }

    const parsed = this.#http.adapter.parsePriceUpdate(result.json, update);
    if (parsed.success === false) {
      return {
        outcome: {
          ...base,
          status: "failed",
          message: "Newegg accepted the request but reported Result=0 (failure) for this item.",
        },
        rateLimit: result.rateLimit,
      };
    }
    if (!verify) {
      return {
        outcome: { ...base, status: "accepted", observedSellingPrice: parsed.sellingPrice },
        rateLimit: result.rateLimit,
      };
    }
    try {
      const observed = await readBack();
      if (matches(observed)) {
        return {
          outcome: { ...base, status: "verified", observedSellingPrice: observed },
          rateLimit: result.rateLimit,
        };
      }
      return {
        outcome: {
          ...base,
          status: "unverified",
          observedSellingPrice: observed,
          message:
            "Newegg accepted the write but a read-back does not show the new price (a " +
            "deactivated or promotion-locked item, or read lag): re-read it before trusting it.",
        },
        rateLimit: result.rateLimit,
      };
    } catch (readErr) {
      if (isAbortError(readErr)) throw readErr;
      const detail = readErr instanceof NeweggError ? readErr.message : "unexpected error";
      return {
        outcome: {
          ...base,
          status: "unverified",
          observedSellingPrice: parsed.sellingPrice,
          message: `Newegg accepted the write but the read-back failed: ${detail}`,
        },
        rateLimit: result.rateLimit,
      };
    }
  }
}
