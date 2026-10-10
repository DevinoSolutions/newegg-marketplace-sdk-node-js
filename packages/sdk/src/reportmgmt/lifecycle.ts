/**
 * The shared async lifecycle of every Reports Management (`reportmgmt`) report:
 * submit -> poll status -> fetch result (contracts §12 / §17). Extracted from `catalog/` so the
 * Item Lookup report and the settlement / inventory reports share one implementation of the
 * request plumbing, the tolerant status/submit parsers, the poll backoff and `raw` redaction.
 *
 * Everything here is READ-shaped: submitting a report creates a report job and mutates nothing
 * on the seller account (§12 classification, owner-approved).
 */
import { randomUUID } from "node:crypto";
import type { NeweggMarketplace, RateLimitInfo, ReportState, RequestOptions } from "../types.js";
import type { RequestSpec } from "../platform/index.js";
import type { NeweggHttpClient } from "../client/http.js";
import type { NeweggError } from "../errors/index.js";
import { NeweggApiError } from "../errors/index.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { asArray, asNumber, asString, getField, getPath, isRecord } from "../schemas/wire.js";
import { delay } from "../util.js";
import {
  REPORT_DEFAULT_MAX_POLL_INTERVAL_MS,
  REPORT_DEFAULT_POLL_INTERVAL_MS,
  REPORT_DEFAULT_TIMEOUT_MS,
  REPORT_POLL_BACKOFF_FACTOR,
  REPORT_RESULT_PATH,
  REPORT_STATUS_OPERATION_TYPE,
  REPORT_STATUS_PATH,
  REPORT_SUBMIT_PATH,
} from "./constants.js";
import { sanitizeRaw } from "./redact.js";

/** Operation identifiers (rate-limit keys + log fields) for one report family. */
export interface ReportOperations {
  readonly submit: string;
  readonly status: string;
  readonly result: string;
}

/** Per-call options: the common request options plus an optional extra query (e.g. `version`). */
export interface ReportCallOptions extends RequestOptions {
  query?: Record<string, string>;
}

interface CallMeta {
  marketplace: NeweggMarketplace;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface SubmitOutcome extends CallMeta {
  requestId: string;
  /** Newegg's `RequestType` echo (e.g. `SETTLEMENT_SUMMARY_REPORT`), when present. */
  requestType?: string;
  /** Raw Pacific `RequestDate` string, when present. */
  requestDate?: string;
}

export interface StatusOutcome extends CallMeta {
  requestId: string;
  status: ReportState;
  /** Newegg's literal status string, for diagnostics when `status` is `"unknown"`. */
  statusRaw?: string;
  requestType?: string;
  totalCount?: number;
}

export interface ResultOutcome extends CallMeta {
  json: unknown;
}

/** Polling knobs shared by every `wait*` helper. */
export interface WaitOptions {
  signal?: AbortSignal;
  /** Overall budget for the wait, ms. */
  timeoutMs?: number;
  /** First poll delay, ms. Grows 1.5x per poll up to `maxPollIntervalMs`. */
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
}

/** Builds the errors a wait raises; each family keeps its own error class (catalog vs reports). */
export interface WaitErrorFactory {
  cancelled(requestId: string): NeweggError;
  timedOut(requestId: string): NeweggError;
}

// ---------------------------------------------------------------------------
// request builders / tolerant parsers (also re-exported by catalog/parse.ts)
// ---------------------------------------------------------------------------

/** Builds the report-status body (§12.2 - note the `GetRequestStatus` wrapper). */
export function buildStatusRequest(requestId: string): Record<string, unknown> {
  return {
    OperationType: REPORT_STATUS_OPERATION_TYPE,
    RequestBody: {
      GetRequestStatus: { RequestIDList: { RequestID: requestId }, MaxCount: 100 },
    },
  };
}

/** Strips the optional `NeweggAPIResponse` wrapper some report responses carry. */
export function unwrapEnvelope(json: unknown): unknown {
  const inner = getField(json, "NeweggAPIResponse");
  return isRecord(inner) ? inner : json;
}

function requestIdOf(entry: unknown): string | undefined {
  return asString(getField(entry, "RequestId")) ?? asString(getField(entry, "RequestID"));
}

/** Unwraps `ResponseBody.ResponseList` into entries, tolerating the XML-shaped
 * `ResponseList: { ResponseInfo: {...} }` nesting alongside the JSON array form. */
function responseListEntries(json: unknown): unknown[] {
  const list = getPath(unwrapEnvelope(json), ["ResponseBody", "ResponseList"]);
  const inner = getField(list, "ResponseInfo");
  return asArray(inner !== undefined ? inner : list);
}

/**
 * Extracts the request id from a submit response (§12.1: nested in `ResponseList`). `label`
 * names the report in the error ("item lookup", "settlement summary report", ...).
 */
export function parseSubmitResponse(
  json: unknown,
  label = "report",
  operation = "reports.submit",
): { requestId: string; requestType?: string; requestDate?: string } {
  for (const entry of responseListEntries(json)) {
    const requestId = requestIdOf(entry);
    if (requestId !== undefined && requestId !== "") {
      const requestType = asString(getField(entry, "RequestType"));
      const requestDate = asString(getField(entry, "RequestDate"));
      return {
        requestId,
        ...(requestType !== undefined ? { requestType } : {}),
        ...(requestDate !== undefined ? { requestDate } : {}),
      };
    }
  }
  throw new NeweggApiError(`Newegg returned no request id for the ${label} submission.`, {
    details: { operation },
  });
}

const STATUS_MAP: Record<string, ReportState> = {
  SUBMITTED: "submitted",
  IN_PROGRESS: "inProgress",
  FINISHED: "finished",
  CANCELLED: "cancelled",
};

/** Maps a status response (§12.2) to the state union for the given request id. */
export function parseStatusResponse(
  json: unknown,
  requestId: string,
): { status: ReportState; statusRaw?: string; requestType?: string; totalCount?: number } {
  const entries = responseListEntries(json);
  // Prefer the entry matching our request id; fall back to the first (we ask for one id).
  const entry = entries.find((e) => requestIdOf(e) === requestId) ?? entries[0];
  const requestType = asString(getField(entry, "RequestType"));
  const totalCount = asNumber(getField(entry, "TotalCount"));
  const extras = {
    ...(requestType !== undefined ? { requestType } : {}),
    ...(totalCount !== undefined ? { totalCount } : {}),
  };
  // The docs spell the field both RequestStatus and RequestSatus (typo in the field table).
  const raw =
    asString(getField(entry, "RequestStatus")) ?? asString(getField(entry, "RequestSatus"));
  if (raw === undefined) return { status: "unknown", ...extras };
  const mapped = STATUS_MAP[raw.trim().toUpperCase()];
  return mapped !== undefined
    ? { status: mapped, ...extras }
    : { status: "unknown", statusRaw: raw, ...extras };
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

/** Submit / status / result plumbing for one family of reports (one {@link ReportOperations}). */
export class ReportLifecycle {
  readonly #http: NeweggHttpClient;
  readonly #ops: ReportOperations;
  readonly #label: string;

  constructor(http: NeweggHttpClient, ops: ReportOperations, label: string) {
    this.#http = http;
    this.#ops = ops;
    this.#label = label;
  }

  async #send(
    spec: RequestSpec,
    operation: string,
    options: ReportCallOptions,
  ): Promise<{ json: unknown; meta: CallMeta }> {
    const { marketplace, sellerId } = this.#http.config;
    const correlationId = options.correlationId ?? randomUUID();
    const result = await this.#http.request(spec, {
      operation,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, operation),
    });
    return {
      json: result.json,
      meta: {
        marketplace,
        correlationId,
        rateLimit: result.rateLimit,
        raw: options.includeRaw ? sanitizeRaw(result.json) : undefined,
      },
    };
  }

  #spec(
    method: "POST" | "PUT",
    path: string,
    body: unknown,
    options: ReportCallOptions,
  ): RequestSpec {
    return {
      method,
      path: `${this.#http.adapter.prefix}${path}`,
      body,
      ...(options.query !== undefined ? { query: options.query } : {}),
    };
  }

  /** `POST reportmgmt/report/submitrequest` (100/hour). */
  async submit(body: unknown, options: ReportCallOptions = {}): Promise<SubmitOutcome> {
    const { json, meta } = await this.#send(
      this.#spec("POST", REPORT_SUBMIT_PATH, body, options),
      this.#ops.submit,
      options,
    );
    const parsed = parseSubmitResponse(json, this.#label, this.#ops.submit);
    return { ...meta, ...parsed };
  }

  /** `PUT reportmgmt/report/status` (500/hour). */
  async status(requestId: string, options: ReportCallOptions = {}): Promise<StatusOutcome> {
    const { json, meta } = await this.#send(
      this.#spec("PUT", REPORT_STATUS_PATH, buildStatusRequest(requestId), options),
      this.#ops.status,
      options,
    );
    return { ...meta, requestId, ...parseStatusResponse(json, requestId) };
  }

  /** `PUT reportmgmt/report/result` (500/hour); the caller parses `json` for its report type. */
  async result(body: unknown, options: ReportCallOptions = {}): Promise<ResultOutcome> {
    const { json, meta } = await this.#send(
      this.#spec("PUT", REPORT_RESULT_PATH, body, options),
      this.#ops.result,
      options,
    );
    return { ...meta, json };
  }
}

/**
 * Polls `getState` until the report is FINISHED. CANCELLED and the deadline both abort with
 * the errors from `errors` (each carries the request id so callers continue instead of
 * resubmitting - submissions are budgeted at 100/hour). Backoff: `pollIntervalMs` x1.5 per
 * poll up to `maxPollIntervalMs`.
 */
export async function waitUntilFinished(
  requestId: string,
  getState: () => Promise<ReportState>,
  errors: WaitErrorFactory,
  options: WaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? REPORT_DEFAULT_TIMEOUT_MS;
  const maxPoll = options.maxPollIntervalMs ?? REPORT_DEFAULT_MAX_POLL_INTERVAL_MS;
  let pollMs = options.pollIntervalMs ?? REPORT_DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await getState();
    if (state === "finished") return;
    if (state === "cancelled") throw errors.cancelled(requestId);
    if (Date.now() + pollMs > deadline) throw errors.timedOut(requestId);
    await delay(pollMs, options.signal);
    pollMs = Math.min(maxPoll, Math.max(1, Math.round(pollMs * REPORT_POLL_BACKOFF_FACTOR)));
  }
}
