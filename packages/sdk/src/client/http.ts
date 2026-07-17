import type { PlatformAdapter, RequestSpec } from "../platform/index.js";
import type { RateLimitInfo } from "../types.js";
import type { ResolvedConfig } from "./config.js";
import { buildRequestHeaders, hashSellerId } from "../auth/index.js";
import { NeweggApiError, NeweggError, NeweggTimeoutError } from "../errors/index.js";
import { parseUpstreamError } from "../errors/parse-upstream.js";
import { LogEvent } from "../logging/index.js";
import { parseRateLimitHeaders } from "../rate-limit/index.js";
import { delay, isAbortError } from "../util.js";
import { computeRetryDelay } from "./retry.js";
import { classifyTransport, TransportError } from "./transport.js";

/** Per-request context threaded through the client. */
export interface RequestContext {
  operation: string;
  correlationId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  rateLimitKey?: string;
  recordCost?: number;
}

/** Result of a completed (2xx) request. */
export interface HttpResult {
  status: number;
  json: unknown;
  bodyText: string;
  rateLimit?: RateLimitInfo;
  correlationId: string;
}

function parseJsonSafe(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function rateLimitLogSummary(info: RateLimitInfo | undefined): Record<string, unknown> | undefined {
  if (!info) return undefined;
  return {
    requestRemaining: info.requestRemaining,
    requestLimit: info.requestLimit,
    recordRemaining: info.recordRemaining,
  };
}

/**
 * HTTP core: URL/header construction, timeout + `AbortSignal.any` cancellation, rate-limit
 * acquisition and observation, error mapping, retry, and structured logging. Credentials are
 * only ever placed in outbound headers — never logged, and never in `raw`/error payloads.
 */
export class NeweggHttpClient {
  readonly config: ResolvedConfig;
  readonly adapter: PlatformAdapter;
  readonly #sellerIdHash: string;

  constructor(config: ResolvedConfig, adapter: PlatformAdapter) {
    this.config = config;
    this.adapter = adapter;
    this.#sellerIdHash = hashSellerId(config.sellerId);
  }

  get sellerIdHash(): string {
    return this.#sellerIdHash;
  }

  /** Builds the request URL, always adding `sellerid` (original case) plus any spec query. */
  buildUrl(spec: RequestSpec): URL {
    const url = new URL(spec.path, this.config.baseUrl);
    url.searchParams.set("sellerid", this.config.sellerId);
    if (spec.query) {
      for (const [key, value] of Object.entries(spec.query)) url.searchParams.set(key, value);
    }
    return url;
  }

  #logFields(ctx: RequestContext): Record<string, unknown> {
    return {
      correlationId: ctx.correlationId,
      operation: ctx.operation,
      marketplace: this.config.marketplace,
      sellerIdHash: this.#sellerIdHash,
    };
  }

  /** Acquires the local rate-limit budget for a request, logging any wait it incurs. */
  async acquireRateLimit(ctx: RequestContext): Promise<void> {
    if (!ctx.rateLimitKey) return;
    const start = Date.now();
    await this.config.rateLimitStore.acquire(ctx.rateLimitKey, {
      recordCost: ctx.recordCost,
      signal: ctx.signal,
    });
    const waitMs = Date.now() - start;
    if (waitMs > 0) {
      this.config.logger.info(LogEvent.RateLimitWait, { ...this.#logFields(ctx), waitMs });
    }
  }

  /**
   * Executes a single request attempt. Throws a mapped {@link NeweggError} for non-2xx
   * responses, a {@link TransportError} for fetch-level failures, or re-throws a caller abort.
   * Does not retry and does not acquire rate-limit budget.
   */
  async executeOnce(spec: RequestSpec, ctx: RequestContext): Promise<HttpResult> {
    const url = this.buildUrl(spec);
    const headers = buildRequestHeaders({
      apiKey: this.config.apiKey,
      secretKey: this.config.secretKey,
      userAgent: this.config.userAgent,
    });
    const bodyText =
      spec.bodyText ?? (spec.body !== undefined ? JSON.stringify(spec.body) : undefined);

    const timeoutMs = ctx.timeoutMs ?? this.config.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;

    const startedAt = Date.now();
    this.config.logger.debug(LogEvent.RequestStarted, {
      ...this.#logFields(ctx),
      method: spec.method,
      path: url.pathname,
    });

    const target: string | URL =
      spec.rawQuerySuffix !== undefined ? `${url.toString()}&${spec.rawQuerySuffix}` : url;

    let response: Response;
    let bodyStr: string;
    try {
      response = await this.config.fetch(target, {
        method: spec.method,
        headers,
        body: bodyText,
        signal,
      });
      bodyStr = await response.text();
    } catch (err) {
      const classified = classifyTransport(err, ctx.signal?.aborted ?? false);
      throw classified;
    }

    const rateLimit = parseRateLimitHeaders(response.headers);
    if (rateLimit && ctx.rateLimitKey) {
      this.config.rateLimitStore.observe(ctx.rateLimitKey, rateLimit);
    }
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const error = parseUpstreamError(response.status, bodyStr, response.headers, {
        correlationId: ctx.correlationId,
        rateLimit,
      });
      this.config.logger.warn(LogEvent.RequestCompleted, {
        ...this.#logFields(ctx),
        method: spec.method,
        path: url.pathname,
        status: response.status,
        durationMs,
        outcome: "error",
        neweggErrorCode: error.neweggErrorCode,
        rateLimit: rateLimitLogSummary(rateLimit),
      });
      throw error;
    }

    this.config.logger.debug(LogEvent.RequestCompleted, {
      ...this.#logFields(ctx),
      method: spec.method,
      path: url.pathname,
      status: response.status,
      durationMs,
      outcome: "success",
      rateLimit: rateLimitLogSummary(rateLimit),
    });

    return {
      status: response.status,
      json: parseJsonSafe(bodyStr),
      bodyText: bodyStr,
      rateLimit,
      correlationId: ctx.correlationId,
    };
  }

  /** Normalizes any thrown value to a {@link NeweggError} for direct-operation retries. */
  #toNeweggError(err: unknown, ctx: RequestContext): NeweggError {
    if (err instanceof NeweggError) return err;
    if (err instanceof TransportError) {
      if (err.timeout) {
        return new NeweggTimeoutError("Newegg request timed out.", {
          correlationId: ctx.correlationId,
          retryable: true,
          cause: err.cause,
        });
      }
      return new NeweggApiError("Newegg request failed to complete (network error).", {
        correlationId: ctx.correlationId,
        retryable: true,
        details: { causeCode: err.causeCode },
        cause: err.cause,
      });
    }
    return new NeweggApiError("Unexpected error during Newegg request.", {
      correlationId: ctx.correlationId,
      retryable: false,
      cause: err,
    });
  }

  /**
   * Executes a request with local rate-limit acquisition and the direct-operation retry
   * policy (network errors, 408/429/502/503/504, full-jitter backoff honoring reset hints).
   */
  async request(spec: RequestSpec, ctx: RequestContext): Promise<HttpResult> {
    await this.acquireRateLimit(ctx);
    let attempt = 0;
    for (;;) {
      try {
        return await this.executeOnce(spec, ctx);
      } catch (err) {
        if (isAbortError(err)) throw err;
        const mapped = this.#toNeweggError(err, ctx);
        const canRetry = mapped.retryable && attempt + 1 < this.config.retry.maxAttempts;
        if (!canRetry) throw mapped;
        const delayMs = computeRetryDelay(mapped, attempt, this.config.retry);
        this.config.logger.info(LogEvent.RetryScheduled, {
          ...this.#logFields(ctx),
          attempt: attempt + 1,
          delayMs,
          reason: mapped.code,
          neweggErrorCode: mapped.neweggErrorCode,
        });
        await delay(delayMs, ctx.signal);
        attempt++;
      }
    }
  }
}
