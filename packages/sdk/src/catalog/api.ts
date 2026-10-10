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
import type { NeweggHttpClient } from "../client/http.js";
import {
  CatalogLookupTimeoutError,
  NeweggApiError,
  NeweggValidationError,
} from "../errors/index.js";
import { Operation } from "../client/operations.js";
import { ReportLifecycle, waitUntilFinished } from "../reportmgmt/lifecycle.js";
import { ITEM_LOOKUP_MAX_ITEMS } from "./constants.js";
import {
  buildLookupResultRequest,
  buildLookupSubmitRequest,
  parseLookupResultResponse,
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
 * nothing on the seller account (§12 classification, owner-approved). The submit / status /
 * result plumbing and the poll backoff are the shared `reportmgmt` lifecycle (also used by
 * `client.reports`); only the Item Lookup request/response shapes live in `./parse.ts`.
 */
export class CatalogApiImpl implements CatalogApi {
  readonly #http: NeweggHttpClient;
  readonly #lifecycle: ReportLifecycle;

  constructor(http: NeweggHttpClient) {
    this.#http = http;
    this.#lifecycle = new ReportLifecycle(
      http,
      {
        submit: Operation.CatalogLookupSubmit,
        status: Operation.CatalogLookupStatus,
        result: Operation.CatalogLookupResult,
      },
      "item lookup",
    );
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
    const outcome = await this.#lifecycle.submit(buildLookupSubmitRequest(wireInputs), options);
    return {
      marketplace: outcome.marketplace,
      requestId: outcome.requestId,
      correlationId: outcome.correlationId,
      rateLimit: outcome.rateLimit,
      raw: outcome.raw,
    };
  }

  async lookupStatus(
    requestId: string,
    options: RequestOptions = {},
  ): Promise<CatalogLookupStatus> {
    const outcome = await this.#lifecycle.status(requestId, options);
    return {
      marketplace: outcome.marketplace,
      requestId,
      status: outcome.status,
      statusRaw: outcome.statusRaw,
      correlationId: outcome.correlationId,
      rateLimit: outcome.rateLimit,
      raw: outcome.raw,
    };
  }

  async lookupResult(
    requestId: string,
    page = 1,
    options: RequestOptions = {},
  ): Promise<CatalogLookupResultPage> {
    const outcome = await this.#lifecycle.result(
      buildLookupResultRequest(requestId, page),
      options,
    );
    const parsed = parseLookupResultResponse(outcome.json);
    return {
      marketplace: outcome.marketplace,
      requestId,
      matches: parsed.matches,
      page: parsed.page,
      pageSize: parsed.pageSize,
      totalCount: parsed.totalCount,
      totalPageCount: parsed.totalPageCount,
      correlationId: outcome.correlationId,
      rateLimit: outcome.rateLimit,
      raw: outcome.raw,
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

    const wireInputs = inputs.filter((i): i is WireLookupInput => !isPassthrough(i));
    let requestId: string | undefined;
    let allMatches: CatalogMatch[] = [];
    let lastRaw: unknown;

    if (wireInputs.length > 0) {
      const submission = await this.submitLookup(wireInputs, {
        correlationId,
        signal: options.signal,
      });
      const submittedId = submission.requestId;
      requestId = submittedId;

      // Poll until FINISHED; CANCELLED and the deadline both abort with the requestId attached.
      await waitUntilFinished(
        submittedId,
        async () =>
          (await this.lookupStatus(submittedId, { correlationId, signal: options.signal })).status,
        {
          cancelled: (id) =>
            new CatalogLookupTimeoutError(
              "Newegg cancelled the item lookup report; resubmit to retry.",
              { requestId: id, correlationId, retryable: false },
            ),
          timedOut: (id) =>
            new CatalogLookupTimeoutError(
              "The item lookup report did not finish within the time budget; continue with " +
                "catalog.lookupStatus/lookupResult using requestId instead of resubmitting.",
              { requestId: id, correlationId },
            ),
        },
        {
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          pollIntervalMs: options.pollIntervalMs,
          maxPollIntervalMs: options.maxPollIntervalMs,
        },
      );

      // Fetch every page.
      let page = 1;
      for (;;) {
        let result: CatalogLookupResultPage;
        try {
          result = await this.lookupResult(submittedId, page, {
            correlationId,
            signal: options.signal,
            includeRaw: options.includeRaw,
          });
        } catch (error) {
          // Proven live (5/5): a report whose criteria include two inputs matching the SAME
          // catalog product (e.g. a UPC plus that product's manufacturer+MPN) reaches
          // FINISHED but its result endpoint returns HTTP 500 InternalError forever. The
          // raw 500 looks like an outage; diagnose it so callers can fix their inputs.
          if (error instanceof NeweggApiError && error.httpStatus === 500) {
            throw new NeweggApiError(
              `Newegg failed to produce the item lookup report result (HTTP 500, ` +
                `requestId ${submittedId}). If this persists across retries the report is ` +
                `likely poisoned: submitting two criteria that match the same catalog ` +
                `product (for example a UPC and that product's manufacturer+MPN) breaks ` +
                `result generation permanently. De-duplicate inputs by product and ` +
                `resubmit; this report cannot be recovered.`,
              {
                httpStatus: 500,
                neweggErrorCode: error.neweggErrorCode,
                correlationId,
                retryable: false,
                details: { requestId: submittedId, page, cause: error.message },
              },
            );
          }
          throw error;
        }
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
