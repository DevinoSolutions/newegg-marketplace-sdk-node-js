import { isRecord } from "../util.js";

/** Whether a failed request could have reached Newegg. */
type SendPhase = "pre-send" | "ambiguous";

/**
 * Internal error for fetch-level failures (never surfaced to callers directly). `phase`
 * distinguishes a provably-unsent failure (DNS/connect refused) from an ambiguous one
 * (timeout/reset after dispatch), which drives the feed-submission retry policy (ADR 0004).
 */
export class TransportError extends Error {
  readonly phase: SendPhase;
  readonly timeout: boolean;
  readonly causeCode?: string;
  constructor(phase: SendPhase, timeout: boolean, cause: unknown, causeCode?: string) {
    super("Transport failure", cause !== undefined ? { cause } : undefined);
    this.name = "TransportError";
    this.phase = phase;
    this.timeout = timeout;
    this.causeCode = causeCode;
  }
}

/**
 * `causeCode` of a {@link TransportError} raised when a WRITE request was answered with an HTTP
 * redirect. The body had already been sent, so the outcome is ambiguous (ADR 0004); the redirect is
 * never followed because that would replay the POST/PUT body (and the credential headers) at
 * whatever host the response names.
 */
export const REDIRECT_REFUSED = "REDIRECT_REFUSED";

const PRE_SEND_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"]);

/** Extracts an error's `cause.code` (e.g. ECONNREFUSED) when present. */
function errorCauseCode(err: unknown): string | undefined {
  if (isRecord(err) && "cause" in err) {
    const cause = err.cause;
    if (isRecord(cause) && typeof cause.code === "string") return cause.code;
  }
  if (isRecord(err) && typeof err.code === "string") return err.code;
  return undefined;
}

/** True for the error undici's fetch raises when `redirect: "error"` meets a redirect response. */
function isRedirectRefusal(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    err.cause instanceof Error &&
    err.cause.message === "unexpected redirect"
  );
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * Classifies a thrown fetch/read error. Caller-initiated aborts are re-thrown as-is (so
 * cancellation propagates as a DOMException); everything else becomes a {@link TransportError}.
 */
export function classifyTransport(err: unknown, callerAborted: boolean): TransportError | unknown {
  if (isAbort(err)) {
    if (callerAborted) return err; // caller cancellation — propagate unchanged
    return new TransportError("ambiguous", true, err);
  }
  if (isRedirectRefusal(err)) {
    return new TransportError("ambiguous", false, err, REDIRECT_REFUSED);
  }
  const code = errorCauseCode(err);
  if (code && PRE_SEND_CODES.has(code)) {
    return new TransportError("pre-send", false, err, code);
  }
  // ECONNRESET / EPIPE / ETIMEDOUT / unknown network failures — could have reached Newegg.
  return new TransportError("ambiguous", false, err, code);
}
