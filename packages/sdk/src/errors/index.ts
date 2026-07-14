import type { NeweggMarketplace, RateLimitInfo } from "../types.js";

/** Machine-readable category shared by every SDK error. */
export type NeweggErrorCode =
  | "configuration"
  | "validation"
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "api"
  | "feed_submission"
  | "feed_submission_indeterminate"
  | "feed_processing"
  | "feed_cancelled"
  | "order_write_indeterminate"
  | "timeout"
  | "unsupported_operation";

export interface NeweggErrorInit {
  httpStatus?: number;
  /** e.g. CT002, DF012, InvalidToken. */
  neweggErrorCode?: string;
  /** Feed request id when relevant. */
  neweggRequestId?: string;
  correlationId?: string;
  retryable?: boolean;
  /** Sanitized, JSON-safe. Never contains credentials. */
  details?: unknown;
  cause?: unknown;
}

/**
 * Base class for every error thrown by the SDK. All fields are JSON-safe; `toJSON`
 * never emits credential material (message strings are authored by the SDK and the
 * `details` payload is sanitized before construction).
 */
export class NeweggError extends Error {
  readonly code: NeweggErrorCode;
  readonly httpStatus?: number;
  readonly neweggErrorCode?: string;
  readonly neweggRequestId?: string;
  readonly correlationId?: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: NeweggErrorCode, message: string, init: NeweggErrorInit = {}) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "NeweggError";
    this.code = code;
    this.httpStatus = init.httpStatus;
    this.neweggErrorCode = init.neweggErrorCode;
    this.neweggRequestId = init.neweggRequestId;
    this.correlationId = init.correlationId;
    this.retryable = init.retryable ?? false;
    this.details = init.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      neweggErrorCode: this.neweggErrorCode,
      neweggRequestId: this.neweggRequestId,
      correlationId: this.correlationId,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export class NeweggConfigurationError extends NeweggError {
  constructor(message: string, init: NeweggErrorInit = {}) {
    super("configuration", message, init);
    this.name = "NeweggConfigurationError";
  }
}

export interface NeweggValidationIssue {
  path: string;
  message: string;
  inputIndex?: number;
}

export class NeweggValidationError extends NeweggError {
  readonly issues: NeweggValidationIssue[];
  constructor(message: string, issues: NeweggValidationIssue[], init: NeweggErrorInit = {}) {
    super("validation", message, init);
    this.name = "NeweggValidationError";
    this.issues = issues;
  }
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), issues: this.issues };
  }
}

export class NeweggAuthenticationError extends NeweggError {
  constructor(message: string, init: NeweggErrorInit = {}) {
    super("authentication", message, init);
    this.name = "NeweggAuthenticationError";
  }
}

export class NeweggAuthorizationError extends NeweggError {
  constructor(message: string, init: NeweggErrorInit = {}) {
    super("authorization", message, init);
    this.name = "NeweggAuthorizationError";
  }
}

export interface NeweggRateLimitErrorInit extends NeweggErrorInit {
  rateLimit?: RateLimitInfo;
  retryAfterMs?: number;
}

export class NeweggRateLimitError extends NeweggError {
  readonly rateLimit?: RateLimitInfo;
  readonly retryAfterMs?: number;
  constructor(message: string, init: NeweggRateLimitErrorInit = {}) {
    super("rate_limit", message, { ...init, retryable: init.retryable ?? true });
    this.name = "NeweggRateLimitError";
    this.rateLimit = init.rateLimit;
    this.retryAfterMs = init.retryAfterMs;
  }
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), rateLimit: this.rateLimit, retryAfterMs: this.retryAfterMs };
  }
}

export class NeweggApiError extends NeweggError {
  constructor(message: string, init: NeweggErrorInit = {}) {
    super("api", message, init);
    this.name = "NeweggApiError";
  }
}

export class NeweggFeedSubmissionError extends NeweggError {
  constructor(message: string, init: NeweggErrorInit = {}) {
    super("feed_submission", message, init);
    this.name = "NeweggFeedSubmissionError";
  }
}

export interface IndeterminateFeedSubmissionErrorInit extends NeweggErrorInit {
  payloadHash: string;
  marketplace: NeweggMarketplace;
  submittedAtIso: string;
  guidance?: string;
}

export class IndeterminateFeedSubmissionError extends NeweggError {
  readonly payloadHash: string;
  readonly marketplace: NeweggMarketplace;
  readonly submittedAtIso: string;
  readonly guidance: string;
  constructor(message: string, init: IndeterminateFeedSubmissionErrorInit) {
    super("feed_submission_indeterminate", message, { ...init, retryable: false });
    this.name = "IndeterminateFeedSubmissionError";
    this.payloadHash = init.payloadHash;
    this.marketplace = init.marketplace;
    this.submittedAtIso = init.submittedAtIso;
    this.guidance =
      init.guidance ??
      "The feed request may or may not have reached Newegg. Check recent feed status " +
        "(feeds.getStatus) before resubmitting to avoid a double submission.";
  }
  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      payloadHash: this.payloadHash,
      marketplace: this.marketplace,
      submittedAtIso: this.submittedAtIso,
      guidance: this.guidance,
    };
  }
}

export interface IndeterminateOrderWriteErrorInit extends NeweggErrorInit {
  marketplace: NeweggMarketplace;
  /** The order-write operation that was in flight, e.g. `"orders.ship"`. */
  operation: string;
  submittedAtIso: string;
  orderNumber?: string;
  guidance?: string;
}

/**
 * Thrown when an order mutation (ship / cancel / confirm / remove-item) may have reached Newegg
 * but its outcome is unknown — an ambiguous transport failure (timeout/reset after dispatch) or a
 * 408/5xx returned after the body was sent. Order writes are NOT idempotent, so the SDK never
 * auto-retries past this point: resubmitting could double-ship or double-cancel. Check the order's
 * current state (`orders.getStatus` / `orders.get`) before retrying. `retryable` is always `false`.
 */
export class IndeterminateOrderWriteError extends NeweggError {
  readonly marketplace: NeweggMarketplace;
  readonly operation: string;
  readonly submittedAtIso: string;
  readonly orderNumber?: string;
  readonly guidance: string;
  constructor(message: string, init: IndeterminateOrderWriteErrorInit) {
    super("order_write_indeterminate", message, { ...init, retryable: false });
    this.name = "IndeterminateOrderWriteError";
    this.marketplace = init.marketplace;
    this.operation = init.operation;
    this.submittedAtIso = init.submittedAtIso;
    this.orderNumber = init.orderNumber;
    this.guidance =
      init.guidance ??
      "The order write may or may not have reached Newegg. Check the order status " +
        "(orders.getStatus) before retrying to avoid a double ship/cancel.";
  }
  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      marketplace: this.marketplace,
      operation: this.operation,
      submittedAtIso: this.submittedAtIso,
      orderNumber: this.orderNumber,
      guidance: this.guidance,
    };
  }
}

export class NeweggFeedProcessingError extends NeweggError {
  constructor(message: string, init: NeweggErrorInit = {}) {
    super("feed_processing", message, init);
    this.name = "NeweggFeedProcessingError";
  }
}

export class NeweggFeedCancelledError extends NeweggError {
  constructor(message: string, init: NeweggErrorInit = {}) {
    super("feed_cancelled", message, init);
    this.name = "NeweggFeedCancelledError";
  }
}

export class NeweggTimeoutError extends NeweggError {
  constructor(message: string, init: NeweggErrorInit = {}) {
    super("timeout", message, { ...init, retryable: init.retryable ?? true });
    this.name = "NeweggTimeoutError";
  }
}

export class UnsupportedMarketplaceOperationError extends NeweggError {
  constructor(message: string, init: NeweggErrorInit = {}) {
    super("unsupported_operation", message, init);
    this.name = "UnsupportedMarketplaceOperationError";
  }
}
