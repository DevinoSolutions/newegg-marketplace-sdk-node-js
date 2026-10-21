/**
 * Sends one NON-idempotent Shipping Label write (create / reprint; contracts §23). A label costs
 * money and ships the order, so the request is never resent once it may have been dispatched
 * (ADR 0004): only a provably-unsent transport failure is retried, and an ambiguous failure (a
 * timeout or reset after dispatch, a caller abort after dispatch, a 408 or any 5xx) throws
 * {@link IndeterminateOrderWriteError} with label-specific guidance.
 */
import type { RequestSpec } from "../platform/index.js";
import type { HttpResult, NeweggHttpClient, RequestContext } from "../client/http.js";
import { IndeterminateOrderWriteError, NeweggApiError, NeweggError } from "../errors/index.js";
import { fullJitterDelay } from "../client/retry.js";
import { TransportError } from "../client/transport.js";
import { delay, isAbortError } from "../util.js";

const LABEL_GUIDANCE =
  "A shipping label may have been bought. Check the order (orders.get / orders.getStatus: a " +
  "Shipped order with a tracking number means the label exists) and use reprint to fetch it " +
  "instead of creating another one (a reprint may itself be billed; a guarded caller such as the " +
  "MCP server may restrict it). Do not resubmit a create request until you have verified " +
  "the order is still unshipped.";

/** Builds the indeterminate error for a label write. */
export function indeterminateLabelWrite(
  http: NeweggHttpClient,
  ctx: RequestContext,
  meta: { operation: string; orderNumber: string },
  message: string,
  submittedAtIso: string,
  cause?: unknown,
): IndeterminateOrderWriteError {
  return new IndeterminateOrderWriteError(message, {
    marketplace: http.config.marketplace,
    operation: meta.operation,
    orderNumber: meta.orderNumber,
    submittedAtIso,
    correlationId: ctx.correlationId,
    cause,
    guidance: LABEL_GUIDANCE,
  });
}

function isAmbiguousStatus(status: number): boolean {
  return status === 408 || (status >= 500 && status <= 599);
}

export async function sendLabelWrite(
  http: NeweggHttpClient,
  spec: RequestSpec,
  ctx: RequestContext,
  meta: { operation: string; orderNumber: string },
): Promise<{ result: HttpResult; submittedAtIso: string }> {
  const { retry } = http.config;
  const submittedAtIso = new Date().toISOString();
  await http.acquireRateLimit(ctx);
  let attempt = 0;
  for (;;) {
    // fetch() rejects without sending when its signal is already aborted; an abort during the
    // flight may have reached Newegg.
    const abortedBeforeSend = ctx.signal?.aborted === true;
    try {
      return { result: await http.executeOnce(spec, ctx), submittedAtIso };
    } catch (err) {
      if (isAbortError(err)) {
        if (abortedBeforeSend) throw err;
        throw indeterminateLabelWrite(
          http,
          ctx,
          meta,
          "The caller aborted the shipping label write after it was dispatched, so it may have reached Newegg and the outcome is unknown.",
          submittedAtIso,
          err,
        );
      }
      const preSendRetryable =
        err instanceof TransportError &&
        err.phase === "pre-send" &&
        attempt + 1 < retry.maxAttempts;
      if (preSendRetryable) {
        await delay(fullJitterDelay(attempt, retry), ctx.signal);
        attempt++;
        continue;
      }
      const ambiguous =
        (err instanceof TransportError && err.phase === "ambiguous") ||
        (err instanceof NeweggError &&
          err.httpStatus !== undefined &&
          isAmbiguousStatus(err.httpStatus));
      if (ambiguous) {
        throw indeterminateLabelWrite(
          http,
          ctx,
          meta,
          "The shipping label write may have reached Newegg but the outcome is unknown.",
          submittedAtIso,
          err,
        );
      }
      if (err instanceof TransportError) {
        throw new NeweggApiError(
          "The shipping label write failed before dispatch and was not sent.",
          {
            correlationId: ctx.correlationId,
            retryable: false,
            cause: err.cause,
          },
        );
      }
      throw err;
    }
  }
}
