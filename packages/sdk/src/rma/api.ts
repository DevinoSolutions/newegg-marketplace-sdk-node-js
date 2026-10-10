import { randomUUID } from "node:crypto";
import type { ListRmasInput, RequestOptions, Rma, RmaApi, RmasPage } from "../types.js";
import type { RequestSpec } from "../platform/index.js";
import type { NeweggHttpClient } from "../client/http.js";
import { NeweggApiError, NeweggValidationError } from "../errors/index.js";
import { Operation } from "../client/operations.js";
import { getRmaPlatform, resolveRmaVersion } from "../platform/rma.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { RMA_INFO_PATH } from "./constants.js";
import { buildRmaInfoRequest, parseRmaResponse } from "./parse.js";

/**
 * RMA reads (contracts §18.1): Get RMA Information, a READ via PUT (1000 req/hr). `get`/`tryGet`
 * are a keyword search on the RMA number. Submit / Edit / Process / Reject RMA are WRITES and are
 * deliberately not implemented.
 */
export class RmaApiImpl implements RmaApi {
  readonly #http: NeweggHttpClient;

  constructor(http: NeweggHttpClient) {
    this.#http = http;
  }

  async list(input: ListRmasInput = {}, options: RequestOptions = {}): Promise<RmasPage> {
    const { marketplace, sellerId } = this.#http.config;
    const platform = getRmaPlatform(marketplace);
    const version = resolveRmaVersion(platform, input.version);
    const correlationId = options.correlationId ?? randomUUID();
    const { body, pageIndex, pageSize } = buildRmaInfoRequest(input);
    const spec: RequestSpec = {
      method: "PUT",
      path: `${this.#http.adapter.prefix}${RMA_INFO_PATH}`,
      query: { version },
      body,
    };
    const result = await this.#http.request(spec, {
      operation: Operation.RmaList,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.RmaList),
    });
    const parsed = parseRmaResponse(result.json, correlationId);
    return {
      marketplace,
      rmas: parsed.rmas,
      currency: platform.currency,
      page: parsed.page.pageIndex || pageIndex,
      pageSize: parsed.page.pageSize || pageSize,
      totalCount: parsed.page.totalCount,
      totalPageCount: parsed.page.totalPageCount,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async get(rmaNumber: string | number, options: RequestOptions = {}): Promise<Rma> {
    const page = await this.#lookup(rmaNumber, options);
    const rma = page.rmas.find((candidate) => candidate.rmaNumber === String(rmaNumber).trim());
    if (!rma) {
      throw new NeweggApiError("Newegg returned no RMA for the requested RMA number.", {
        correlationId: page.correlationId,
        details: { rmaNumber: String(rmaNumber) },
      });
    }
    return rma;
  }

  async tryGet(rmaNumber: string | number, options: RequestOptions = {}): Promise<Rma | undefined> {
    const page = await this.#lookup(rmaNumber, options);
    return page.rmas.find((candidate) => candidate.rmaNumber === String(rmaNumber).trim());
  }

  async #lookup(rmaNumber: string | number, options: RequestOptions): Promise<RmasPage> {
    const value = String(rmaNumber).trim();
    if (!/^\d+$/.test(value)) {
      throw new NeweggValidationError("Invalid RMA number.", [
        { path: "rmaNumber", message: "must be a positive integer" },
      ]);
    }
    return this.list({ keyword: { type: "rmaNumber", value }, pageSize: 1 }, options);
  }
}
