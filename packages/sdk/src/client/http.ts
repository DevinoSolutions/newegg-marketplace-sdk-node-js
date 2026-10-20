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
import { isReadOperation } from "./operations.js";
import {
  isFollowedRedirect,
  MAX_READ_REDIRECTS,
  REDIRECT_REFUSED_CROSS_ORIGIN,
  REDIRECT_REFUSED_DOWNGRADE,
  REDIRECT_REFUSED_INVALID_LOCATION,
  REDIRECT_REFUSED_TOO_MANY,
  redirectedMethod,
  resolveRedirectTarget,
  type RedirectRefusal,
} from "./redirect.js";
import { classifyTransport, REDIRECT_REFUSED, TransportError } from "./transport.js";

const REDIRECT_REFUSAL_MESSAGE: Record<RedirectRefusal, string> = {
  [REDIRECT_REFUSED_CROSS_ORIGIN]:
    "Newegg answered a read with a redirect to a different origin. It was not followed, so the " +
    "API credentials were not sent there.",
  [REDIRECT_REFUSED_DOWNGRADE]:
    "Newegg answered a read with a redirect from https to http. It was not followed.",
  [REDIRECT_REFUSED_TOO_MANY]: `Newegg answered a read with more than ${MAX_READ_REDIRECTS} redirects. The chain was not followed any further.`,
  [REDIRECT_REFUSED_INVALID_LOCATION]:
    "Newegg answered a read with a redirect whose Location could not be used. It was not followed.",
};

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
   *
   * Reads handle redirects manually (see `#fetchRead`): only a same-origin
   * redirect is followed, at most {@link MAX_READ_REDIRECTS} times and never from https to http, so
   * the credential headers never reach another host. Every other operation is sent with
   * `redirect: "error"`, so a 307/308 can never replay a write body (or the credential headers) at
   * another host; the refusal is an ambiguous {@link TransportError}, because Newegg had already
   * received the request. Whether an operation is a read is decided by {@link isReadOperation},
   * never by the HTTP verb.
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

    const isRead = isReadOperation(ctx.operation);
    const redirect = isRead ? "manual" : "error";

    let response: Response;
    let bodyStr: string;
    try {
      if (isRead) {
        ({ response, bodyStr } = await this.#fetchRead(
          target,
          spec.method,
          headers,
          bodyText,
          signal,
          ctx,
        ));
      } else {
        response = await this.config.fetch(target, {
          method: spec.method,
          headers,
          body: bodyText,
          signal,
          redirect,
        });
        bodyStr = await response.text();
      }
    } catch (err) {
      if (err instanceof NeweggError) throw err;
      const classified = classifyTransport(err, ctx.signal?.aborted ?? false);
      throw classified;
    }

    // `redirect: "error"` makes fetch reject, but a fetch implementation that hands the redirect
    // back (a custom fetch, `redirect: "manual"` semantics) must not be mistaken for a result.
    if (redirect === "error" && response.status >= 300 && response.status < 400) {
      throw new TransportError(
        "ambiguous",
        false,
        new Error(`Newegg answered a write with an HTTP ${response.status} redirect.`),
        REDIRECT_REFUSED,
      );
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

  /**
   * Sends a read, following redirects by hand. A redirect is followed only when its `Location`
   * resolves (relative references included) to the same origin as the original URL, never from
   * https to http, and within {@link MAX_READ_REDIRECTS} hops; anything else throws a
   * non-retryable {@link NeweggApiError} carrying a `REDIRECT_REFUSED_*` cause code. The follow-up
   * keeps the credential headers (same origin, so no other host sees them) and the fetch-standard
   * method/body rewrite of {@link redirectedMethod}.
   */
  async #fetchRead(
    target: string | URL,
    method: string,
    headers: Record<string, string>,
    bodyText: string | undefined,
    signal: AbortSignal,
    ctx: RequestContext,
  ): Promise<{ response: Response; bodyStr: string }> {
    const original = new URL(target);
    let current = original;
    let currentMethod = method;
    let currentBody = bodyText;
    let currentHeaders = headers;
    for (let hops = 0; ; hops++) {
      const response = await this.config.fetch(current, {
        method: currentMethod,
        headers: currentHeaders,
        body: currentBody,
        signal,
        redirect: "manual",
      });
      const location = response.headers.get("location");
      if (!isFollowedRedirect(response.status, location)) {
        return { response, bodyStr: await response.text() };
      }
      await response.body?.cancel().catch(() => undefined);
      const next =
        hops >= MAX_READ_REDIRECTS
          ? REDIRECT_REFUSED_TOO_MANY
          : resolveRedirectTarget(original, current, location ?? "");
      if (typeof next === "string") throw this.#redirectRefused(next, response.status, hops, ctx);
      const rewritten = redirectedMethod(response.status, currentMethod);
      currentMethod = rewritten.method;
      if (rewritten.dropBody) {
        currentBody = undefined;
        currentHeaders = Object.fromEntries(
          Object.entries(currentHeaders).filter(([name]) => name.toLowerCase() !== "content-type"),
        );
      }
      current = next;
    }
  }

  #redirectRefused(
    reason: RedirectRefusal,
    status: number,
    hops: number,
    ctx: RequestContext,
  ): NeweggApiError {
    this.config.logger.warn(LogEvent.RequestCompleted, {
      ...this.#logFields(ctx),
      status,
      outcome: "redirect_refused",
      redirectRefusal: reason,
      redirectsFollowed: hops,
    });
    return new NeweggApiError(REDIRECT_REFUSAL_MESSAGE[reason], {
      correlationId: ctx.correlationId,
      httpStatus: status,
      retryable: false,
      details: { causeCode: reason, redirectsFollowed: hops },
    });
  }

  /** Normalizes any thrown value to a {@link NeweggError} for direct-operation retries. */
  #toNeweggError(err: unknown, ctx: RequestContext): NeweggError {
    if (err instanceof NeweggError) return err;
    if (err instanceof TransportError) {
      if (err.causeCode === REDIRECT_REFUSED) {
        return new NeweggApiError(
          "Newegg answered a write request with an HTTP redirect. The redirect was not followed " +
            "and the request was not retried, but Newegg had already received it, so the write " +
            "may have been applied: check the current state before sending it again.",
          {
            correlationId: ctx.correlationId,
            retryable: false,
            details: { causeCode: err.causeCode },
            cause: err.cause,
          },
        );
      }
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

  /**
   * Executes a request exactly once: local rate-limit acquisition, then a single attempt with NO
   * automatic retry. For calls whose side effects are not proven absent, where a silent resend could
   * repeat them. Every failure is mapped to a {@link NeweggError} (a caller abort is re-thrown).
   */
  async requestOnce(spec: RequestSpec, ctx: RequestContext): Promise<HttpResult> {
    await this.acquireRateLimit(ctx);
    try {
      return await this.executeOnce(spec, ctx);
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw this.#toNeweggError(err, ctx);
    }
  }
}
