/**
 * Shared machinery of the Service Management WRITES (RMA and courtesy refund; contracts §20): the
 * non-idempotent send helper (ADR 0004) and the read-only context loader the preview and the
 * pre-send checks share.
 */
import type {
  CourtesyRefundsPage,
  OrdersApi,
  RefundsApi,
  RequestOptions,
  RmaApi,
  ServiceWriteOperation,
  ServiceWritePreview,
} from "../types.js";
import type { RequestSpec } from "../platform/index.js";
import type { HttpResult, NeweggHttpClient, RequestContext } from "../client/http.js";
import {
  IndeterminateServiceWriteError,
  NeweggApiError,
  NeweggError,
  NeweggValidationError,
} from "../errors/index.js";
import { fullJitterDelay } from "../client/retry.js";
import { TransportError } from "../client/transport.js";
import { delay, isAbortError } from "../util.js";
import type { Findings, OrderContext } from "../rma/write-checks.js";

/**
 * HTTP statuses ambiguous after dispatch (the write may or may not have mutated). For these money-moving
 * service writes EVERY 5xx counts, including a plain 500: a server error after the body was sent does not
 * prove nothing was recorded. (Orders, pricing and feeds keep their own narrower sets.)
 */
function isAmbiguousStatus(status: number): boolean {
  return status === 408 || (status >= 500 && status <= 599);
}

/** What a write concerns, for the indeterminate error and logs. */
export interface ServiceWriteMeta {
  operation: ServiceWriteOperation;
  orderNumber?: string;
  rmaNumber?: string;
}

/** Builds the error for a write whose outcome cannot be established. */
export function indeterminateServiceWrite(
  http: NeweggHttpClient,
  ctx: RequestContext,
  meta: ServiceWriteMeta,
  message: string,
  submittedAtIso: string,
  cause?: unknown,
): IndeterminateServiceWriteError {
  return new IndeterminateServiceWriteError(message, {
    marketplace: http.config.marketplace,
    operation: meta.operation,
    orderNumber: meta.orderNumber,
    rmaNumber: meta.rmaNumber,
    submittedAtIso,
    correlationId: ctx.correlationId,
    cause,
  });
}

/**
 * Sends a single NON-idempotent Service Management write. Retries ONLY provably-unsent transport
 * failures (pre-send); an ambiguous failure (timeout/reset after dispatch, or a 408/any 5xx) throws
 * {@link IndeterminateServiceWriteError} rather than risk a duplicate RMA or refund (ADR 0004). A
 * definitively-unsent transport error surfaces as a non-retryable {@link NeweggApiError}; upstream
 * 4xx `SE0xx` / `CE0xx` errors pass through unchanged.
 */
export async function sendServiceWrite(
  http: NeweggHttpClient,
  spec: RequestSpec,
  ctx: RequestContext,
  meta: ServiceWriteMeta,
): Promise<{ result: HttpResult; submittedAtIso: string }> {
  const { retry } = http.config;
  const submittedAtIso = new Date().toISOString();
  await http.acquireRateLimit(ctx);
  let attempt = 0;
  for (;;) {
    try {
      return { result: await http.executeOnce(spec, ctx), submittedAtIso };
    } catch (err) {
      if (isAbortError(err)) throw err;
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
        throw indeterminateServiceWrite(
          http,
          ctx,
          meta,
          "The RMA / courtesy refund write may have reached Newegg but the outcome is unknown.",
          submittedAtIso,
          err,
        );
      }
      if (err instanceof TransportError) {
        throw new NeweggApiError("The write failed before dispatch and was not sent.", {
          correlationId: ctx.correlationId,
          retryable: false,
          cause: err.cause,
        });
      }
      throw err;
    }
  }
}

/** Throws one {@link NeweggValidationError} when a check run found blockers. */
export function assertNoBlockers(label: string, blockers: readonly string[]): void {
  if (blockers.length === 0) return;
  throw new NeweggValidationError(
    `${label} was not sent: ${blockers.join(" ")}`,
    blockers.map((message) => ({ path: "preflight", message })),
  );
}

/** Peer APIs the write planners read from. `refunds` / `rma` are lazy: the two APIs reference each other. */
export interface ServiceWriteReaders {
  readonly orders: OrdersApi;
  readonly rma: () => RmaApi;
  readonly refunds: () => RefundsApi;
}

/** Reads (and only reads) the order, its RMAs and its courtesy refunds. */
export async function loadOrderContext(
  readers: ServiceWriteReaders,
  orderNumber: string,
  options: RequestOptions,
  findings: Findings,
): Promise<OrderContext> {
  const readOptions: RequestOptions = {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    correlationId: options.correlationId,
  };
  const order = await readers.orders.tryGet(orderNumber, readOptions);
  if (order === undefined) return { order, rmas: [], courtesyRefunds: [] };
  const rmaPage = await readers
    .rma()
    .list({ keyword: { type: "orderNumber", value: orderNumber } }, readOptions);
  const refundPage: CourtesyRefundsPage = await readers
    .refunds()
    .list({ keyword: { type: "orderNumber", value: orderNumber } }, readOptions);
  if (rmaPage.totalCount > rmaPage.rmas.length) {
    findings.warnings.push(
      `Only ${rmaPage.rmas.length} of ${rmaPage.totalCount} RMAs on the order were read; the duplicate and balance checks may be incomplete.`,
    );
  }
  if (refundPage.totalCount > refundPage.refunds.length) {
    findings.warnings.push(
      `Only ${refundPage.refunds.length} of ${refundPage.totalCount} courtesy refunds on the order were read; the balance check may be incomplete.`,
    );
  }
  return {
    order,
    rmas: rmaPage.rmas.filter(
      (rma) => rma.orderNumber === undefined || rma.orderNumber === orderNumber,
    ),
    courtesyRefunds: refundPage.refunds.filter(
      (refund) => refund.orderNumber === undefined || refund.orderNumber === orderNumber,
    ),
  };
}

/** Assembles a {@link ServiceWritePreview}. */
export function buildPreview<N>(args: {
  http: NeweggHttpClient;
  operation: ServiceWriteOperation;
  normalized: N;
  currency: ServiceWritePreview<N>["currency"];
  findings: Findings;
  correlationId: string;
  refundTotal?: number;
  orderNumber?: string;
}): ServiceWritePreview<N> {
  return {
    marketplace: args.http.config.marketplace,
    operation: args.operation,
    normalized: args.normalized,
    currency: args.currency,
    refundTotal: args.refundTotal,
    orderNumber: args.orderNumber,
    blockers: args.findings.blockers,
    warnings: args.findings.warnings,
    correlationId: args.correlationId,
  };
}
