import { randomUUID } from "node:crypto";
import type {
  GetPriceInput,
  GetPriceManyInput,
  GetPriceManyOptions,
  ItemIdentifier,
  ItemPriceSnapshot,
  PriceBatchSnapshot,
  PriceEntry,
  PriceReadFailure,
  PricingApi,
  RequestOptions,
} from "../types.js";
import type { ParsedPrice } from "../platform/index.js";
import type { NeweggHttpClient } from "../client/http.js";
import {
  NeweggApiError,
  NeweggAuthenticationError,
  NeweggAuthorizationError,
  NeweggError,
  NeweggRateLimitError,
} from "../errors/index.js";
import { Operation } from "../client/operations.js";
import { parseOrThrow } from "../inventory/validate.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { getPriceInputSchema, getPriceManyInputSchema } from "../schemas/inputs.js";
import { isAbortError, mapWithConcurrency } from "../util.js";
import {
  DEFAULT_PRICE_READ_CONCURRENCY,
  INFERRED_CURRENCY,
  PRICE_NOT_FOUND_ERROR_CODES,
} from "./constants.js";

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
 * Pricing API. READ-ONLY: every operation here is Get Item Price, which the docs classify as a
 * read on all three platforms even though US sends it as `PUT` and B2B/CAN as `POST`
 * (contracts §15). The mutating price endpoints are deliberately not reachable from this class.
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
}
