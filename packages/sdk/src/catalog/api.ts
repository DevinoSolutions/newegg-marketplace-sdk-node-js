import { randomUUID } from "node:crypto";
import type {
  CatalogApi,
  CatalogLookupInput,
  CatalogLookupResultPage,
  CatalogLookupStatus,
  CatalogLookupSubmission,
  CatalogMatch,
  CatalogResolution,
  RequestOptions,
  ResolveCatalogOptions,
  ResolveCatalogResult,
} from "../types.js";
import type { RequestSpec } from "../platform/index.js";
import type { NeweggHttpClient } from "../client/http.js";
import { CatalogLookupTimeoutError, NeweggValidationError } from "../errors/index.js";
import { Operation } from "../client/operations.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { delay } from "../util.js";
import {
  ITEM_LOOKUP_MAX_ITEMS,
  REPORT_RESULT_PATH,
  REPORT_STATUS_PATH,
  REPORT_SUBMIT_PATH,
  RESOLVE_DEFAULT_MAX_POLL_INTERVAL_MS,
  RESOLVE_DEFAULT_POLL_INTERVAL_MS,
  RESOLVE_DEFAULT_TIMEOUT_MS,
  RESOLVE_POLL_BACKOFF_FACTOR,
} from "./constants.js";
import {
  buildLookupResultRequest,
  buildLookupSubmitRequest,
  buildStatusRequest,
  parseLookupResultResponse,
  parseStatusResponse,
  parseSubmitResponse,
  type WireLookupInput,
} from "./parse.js";

function isPassthrough(input: CatalogLookupInput): input is { neweggItemNumber: string } {
  return "neweggItemNumber" in input;
}

/** Case-insensitive equality for wire identifiers (Newegg's casing is inconsistent). */
function same(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Whether a result row answers this input. Rows echo the submitted criteria (§12.3), so
 * UPC inputs match on UPC and MPN inputs on ManufacturerPartNumber (+ name when present). */
function matchesInput(input: WireLookupInput, match: CatalogMatch): boolean {
  if ("upc" in input) {
    if (!same(input.upc, match.upc)) return false;
  } else {
    if (!same(input.manufacturerPartNumber, match.manufacturerPartNumber)) return false;
    if (match.manufacturer !== undefined && !same(input.manufacturer, match.manufacturer)) {
      return false;
    }
  }
  if (input.condition !== undefined && match.condition !== undefined) {
    return input.condition === match.condition;
  }
  return true;
}

/** Rank for ordering a resolution's matches: condition-bearing rows first. The lookup
 * report interleaves pseudo-rows WITHOUT a Condition field (observed live: R-suffixed
 * refurb echoes like `20-250-259R`, which the item-creation feed rejects) ahead of the
 * real row, so wire order is not a safe order for consumers taking `matches[0]`. */
function matchRank(match: CatalogMatch): number {
  return match.condition !== undefined ? 0 : 1;
}

/**
 * Catalog resolution over the async Item Lookup Report (reportmgmt, contracts §12).
 * Everything here is READ-shaped: report submission creates a report job and mutates
 * nothing on the seller account (§12 classification, owner-approved).
 */
export class CatalogApiImpl implements CatalogApi {
  readonly #http: NeweggHttpClient;

  constructor(http: NeweggHttpClient) {
    this.#http = http;
  }

  get #config() {
    return this.#http.config;
  }

  async submitLookup(
    inputs: CatalogLookupInput[],
    options: RequestOptions = {},
  ): Promise<CatalogLookupSubmission> {
    const wireInputs: WireLookupInput[] = [];
    for (const [index, input] of inputs.entries()) {
      if (isPassthrough(input)) {
        throw new NeweggValidationError(
          "submitLookup only accepts UPC or manufacturer+MPN inputs; a neweggItemNumber needs no lookup.",
          [{ path: "inputs", message: "neweggItemNumber input", inputIndex: index }],
        );
      }
      wireInputs.push(input);
    }
    if (wireInputs.length === 0) {
      throw new NeweggValidationError("submitLookup requires at least one input.", [
        { path: "inputs", message: "empty input list" },
      ]);
    }
    if (wireInputs.length > ITEM_LOOKUP_MAX_ITEMS) {
      throw new NeweggValidationError(
        `submitLookup accepts at most ${ITEM_LOOKUP_MAX_ITEMS} items per submission (RP021).`,
        [{ path: "inputs", message: `got ${wireInputs.length} items` }],
      );
    }
    const { marketplace, sellerId } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const spec: RequestSpec = {
      method: "POST",
      path: `${this.#http.adapter.prefix}${REPORT_SUBMIT_PATH}`,
      body: buildLookupSubmitRequest(wireInputs),
    };
    const result = await this.#http.request(spec, {
      operation: Operation.CatalogLookupSubmit,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.CatalogLookupSubmit),
    });
    const parsed = parseSubmitResponse(result.json);
    return {
      marketplace,
      requestId: parsed.requestId,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async lookupStatus(
    requestId: string,
    options: RequestOptions = {},
  ): Promise<CatalogLookupStatus> {
    const { marketplace, sellerId } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const spec: RequestSpec = {
      method: "PUT",
      path: `${this.#http.adapter.prefix}${REPORT_STATUS_PATH}`,
      body: buildStatusRequest(requestId),
    };
    const result = await this.#http.request(spec, {
      operation: Operation.CatalogLookupStatus,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.CatalogLookupStatus),
    });
    const parsed = parseStatusResponse(result.json, requestId);
    return {
      marketplace,
      requestId,
      status: parsed.status,
      statusRaw: parsed.statusRaw,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async lookupResult(
    requestId: string,
    page = 1,
    options: RequestOptions = {},
  ): Promise<CatalogLookupResultPage> {
    const { marketplace, sellerId } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const spec: RequestSpec = {
      method: "PUT",
      path: `${this.#http.adapter.prefix}${REPORT_RESULT_PATH}`,
      body: buildLookupResultRequest(requestId, page),
    };
    const result = await this.#http.request(spec, {
      operation: Operation.CatalogLookupResult,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.CatalogLookupResult),
    });
    const parsed = parseLookupResultResponse(result.json);
    return {
      marketplace,
      requestId,
      matches: parsed.matches,
      page: parsed.page,
      pageSize: parsed.pageSize,
      totalCount: parsed.totalCount,
      totalPageCount: parsed.totalPageCount,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async resolve(
    input: CatalogLookupInput | CatalogLookupInput[],
    options: ResolveCatalogOptions = {},
  ): Promise<ResolveCatalogResult> {
    const inputs = Array.isArray(input) ? input : [input];
    if (inputs.length === 0) {
      throw new NeweggValidationError("resolve requires at least one input.", [
        { path: "input", message: "empty input list" },
      ]);
    }
    const { marketplace } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const timeoutMs = options.timeoutMs ?? RESOLVE_DEFAULT_TIMEOUT_MS;
    const maxPoll = options.maxPollIntervalMs ?? RESOLVE_DEFAULT_MAX_POLL_INTERVAL_MS;
    let pollMs = options.pollIntervalMs ?? RESOLVE_DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;

    const wireInputs = inputs.filter((i): i is WireLookupInput => !isPassthrough(i));
    let requestId: string | undefined;
    let allMatches: CatalogMatch[] = [];
    let lastRaw: unknown;

    if (wireInputs.length > 0) {
      const submission = await this.submitLookup(wireInputs, {
        correlationId,
        signal: options.signal,
      });
      requestId = submission.requestId;

      // Poll until FINISHED; CANCELLED and the deadline both abort with the requestId attached.
      for (;;) {
        const status = await this.lookupStatus(requestId, {
          correlationId,
          signal: options.signal,
        });
        if (status.status === "finished") break;
        if (status.status === "cancelled") {
          throw new CatalogLookupTimeoutError(
            "Newegg cancelled the item lookup report; resubmit to retry.",
            { requestId, correlationId, retryable: false },
          );
        }
        if (Date.now() + pollMs > deadline) {
          throw new CatalogLookupTimeoutError(
            "The item lookup report did not finish within the time budget; continue with " +
              "catalog.lookupStatus/lookupResult using requestId instead of resubmitting.",
            { requestId, correlationId },
          );
        }
        await delay(pollMs, options.signal);
        pollMs = Math.min(maxPoll, Math.max(1, Math.round(pollMs * RESOLVE_POLL_BACKOFF_FACTOR)));
      }

      // Fetch every page.
      let page = 1;
      for (;;) {
        const result = await this.lookupResult(requestId, page, {
          correlationId,
          signal: options.signal,
          includeRaw: options.includeRaw,
        });
        allMatches = allMatches.concat(result.matches);
        lastRaw = result.raw;
        if (page >= result.totalPageCount) break;
        page += 1;
      }
    }

    const resolutions: CatalogResolution[] = inputs.map((original) => {
      if (isPassthrough(original)) {
        return {
          input: original,
          found: true,
          matches: [{ neweggItemNumber: original.neweggItemNumber }],
        };
      }
      const matches = allMatches
        .filter((m) => matchesInput(original, m))
        // Stable sort: real (condition-bearing) rows before pseudo-rows, wire order within.
        .sort((a, b) => matchRank(a) - matchRank(b));
      return { input: original, found: matches.length > 0, matches };
    });

    return {
      marketplace,
      requestId,
      resolutions,
      correlationId,
      raw: options.includeRaw ? lastRaw : undefined,
    };
  }
}
