import { randomUUID } from "node:crypto";
import type {
  CourtesyRefund,
  CourtesyRefundIssueResult,
  CourtesyRefundRequestStatus,
  CourtesyRefundRequestsResult,
  CourtesyRefundsPage,
  IssueCourtesyRefundInput,
  ListCourtesyRefundRequestsInput,
  ListCourtesyRefundsInput,
  OrdersApi,
  RefundsApi,
  RequestOptions,
  RmaApi,
  ServiceWritePreview,
} from "../types.js";
import type { RequestSpec } from "../platform/index.js";
import type { NeweggHttpClient } from "../client/http.js";
import { NeweggApiError, NeweggValidationError } from "../errors/index.js";
import { Operation } from "../client/operations.js";
import { getRmaPlatform } from "../platform/rma.js";
import { rateLimitKey } from "../rate-limit/index.js";
import {
  assertNoBlockers,
  buildPreview,
  indeterminateServiceWrite,
  loadOrderContext,
  sendServiceWrite,
  type ServiceWriteReaders,
} from "../servicemgmt/write.js";
import { newFindings, checkCourtesyRefund } from "../rma/write-checks.js";
import { COURTESY_REFUND_ISSUE_PATH, fromCents } from "../rma/write-constants.js";
import { normalizeCourtesyRefund } from "../rma/write-validate.js";
import {
  buildIssueCourtesyRefundBody,
  parseCourtesyRefundIssueResponse,
} from "../rma/write-wire.js";
import { COURTESY_REFUND_INFO_PATH, COURTESY_REFUND_STATUS_PATH } from "./constants.js";
import {
  buildCourtesyRefundInfoRequest,
  buildCourtesyRefundStatusRequest,
  parseCourtesyRefundRequestsResponse,
  parseCourtesyRefundsResponse,
} from "./parse.js";

/**
 * Courtesy refund reads (contracts §18.2 / §18.3): Get Courtesy Refund Information (30 req/min)
 * and Get Courtesy Refund Request Status (10,000 req/hr), both READS via PUT. Issue Courtesy
 * Refund (contracts §20.5, 1000 req/hr) is a WRITE that pays the customer: `previewIssue` only
 * reads, `issue` re-runs the same checks, is NOT idempotent and throws
 * `IndeterminateServiceWriteError` instead of retrying after an ambiguous failure (ADR 0004).
 */
export class RefundsApiImpl implements RefundsApi {
  readonly #http: NeweggHttpClient;
  readonly #readers: ServiceWriteReaders;

  constructor(http: NeweggHttpClient, orders: OrdersApi, rma: () => RmaApi) {
    this.#http = http;
    this.#readers = { orders, rma, refunds: () => this };
  }

  async previewIssue(
    input: IssueCourtesyRefundInput,
    options: RequestOptions = {},
  ): Promise<ServiceWritePreview<IssueCourtesyRefundInput>> {
    const { marketplace } = this.#http.config;
    const normalized = normalizeCourtesyRefund(input);
    const correlationId = options.correlationId ?? randomUUID();
    const orderNumber = String(normalized.orderNumber);
    const findings = newFindings();
    const context = await loadOrderContext(
      this.#readers,
      orderNumber,
      { ...options, correlationId },
      findings,
    );
    checkCourtesyRefund({ amount: normalized.amount, context, findings });
    return buildPreview({
      http: this.#http,
      operation: "refunds.issue",
      normalized,
      currency: getRmaPlatform(marketplace).currency,
      findings,
      correlationId,
      refundTotal: fromCents(Math.round(normalized.amount * 100)),
      orderNumber,
    });
  }

  async issue(
    input: IssueCourtesyRefundInput,
    options: RequestOptions = {},
  ): Promise<CourtesyRefundIssueResult> {
    const { marketplace, sellerId } = this.#http.config;
    const preview = await this.previewIssue(input, options);
    assertNoBlockers("Issue courtesy refund", preview.blockers);
    const { normalized, correlationId } = preview;
    const spec: RequestSpec = {
      method: "POST",
      path: `${this.#http.adapter.prefix}${COURTESY_REFUND_ISSUE_PATH}`,
      body: buildIssueCourtesyRefundBody(normalized),
    };
    const ctx = {
      operation: Operation.RefundIssue,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.RefundIssue),
    };
    const meta = {
      operation: "refunds.issue" as const,
      orderNumber: String(normalized.orderNumber),
    };
    const { result, submittedAtIso } = await sendServiceWrite(this.#http, spec, ctx, meta);
    const parsed = parseCourtesyRefundIssueResponse(result.json, correlationId);
    if (parsed.requestId === undefined || parsed.requestId === "") {
      throw indeterminateServiceWrite(
        this.#http,
        ctx,
        meta,
        "Newegg answered the write with a success status but returned no request id, so the outcome is unknown.",
        submittedAtIso,
      );
    }
    return {
      marketplace,
      requestId: parsed.requestId,
      requestDate: parsed.requestDate,
      state: parsed.state,
      stateRaw: parsed.stateRaw,
      memo: parsed.memo,
      orderNumber: String(normalized.orderNumber),
      amount: normalized.amount,
      currency: getRmaPlatform(marketplace).currency,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async list(
    input: ListCourtesyRefundsInput = {},
    options: RequestOptions = {},
  ): Promise<CourtesyRefundsPage> {
    const { marketplace, sellerId } = this.#http.config;
    const correlationId = options.correlationId ?? randomUUID();
    const { body, pageIndex, pageSize } = buildCourtesyRefundInfoRequest(input);
    const spec: RequestSpec = {
      method: "PUT",
      path: `${this.#http.adapter.prefix}${COURTESY_REFUND_INFO_PATH}`,
      body,
    };
    const result = await this.#http.request(spec, {
      operation: Operation.RefundList,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.RefundList),
    });
    const parsed = parseCourtesyRefundsResponse(result.json, correlationId);
    return {
      marketplace,
      refunds: parsed.refunds,
      currency: getRmaPlatform(marketplace).currency,
      page: parsed.page.pageIndex || pageIndex,
      pageSize: parsed.page.pageSize || pageSize,
      totalCount: parsed.page.totalCount,
      totalPageCount: parsed.page.totalPageCount,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async get(courtesyRefundId: string, options: RequestOptions = {}): Promise<CourtesyRefund> {
    const refund = await this.tryGet(courtesyRefundId, options);
    if (!refund) {
      throw new NeweggApiError("Newegg returned no courtesy refund for the requested id.", {
        details: { courtesyRefundId },
      });
    }
    return refund;
  }

  async tryGet(
    courtesyRefundId: string,
    options: RequestOptions = {},
  ): Promise<CourtesyRefund | undefined> {
    const id = typeof courtesyRefundId === "string" ? courtesyRefundId.trim() : "";
    if (id === "") {
      throw new NeweggValidationError("Invalid courtesy refund id.", [
        { path: "courtesyRefundId", message: "must be a non-empty string" },
      ]);
    }
    const page = await this.list(
      { keyword: { type: "courtesyRefundId", value: id }, pageSize: 1 },
      options,
    );
    return page.refunds.find((candidate) => candidate.courtesyRefundId === id);
  }

  async listRequests(
    input: ListCourtesyRefundRequestsInput = {},
    options: RequestOptions = {},
  ): Promise<CourtesyRefundRequestsResult> {
    const { marketplace, sellerId } = this.#http.config;
    const correlationId = options.correlationId ?? randomUUID();
    const body = buildCourtesyRefundStatusRequest(input);
    const spec: RequestSpec = {
      method: "PUT",
      path: `${this.#http.adapter.prefix}${COURTESY_REFUND_STATUS_PATH}`,
      body,
    };
    const result = await this.#http.request(spec, {
      operation: Operation.RefundRequestStatus,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.RefundRequestStatus),
    });
    return {
      marketplace,
      requests: parseCourtesyRefundRequestsResponse(result.json, correlationId),
      currency: getRmaPlatform(marketplace).currency,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async getRequestStatus(
    requestId: string,
    options: RequestOptions = {},
  ): Promise<CourtesyRefundRequestStatus> {
    const id = typeof requestId === "string" ? requestId.trim() : "";
    if (id === "") {
      throw new NeweggValidationError("Invalid courtesy refund request id.", [
        { path: "requestId", message: "must be a non-empty string" },
      ]);
    }
    const result = await this.listRequests({ requestIds: [id], maxCount: 1 }, options);
    const status = result.requests.find((candidate) => candidate.requestId === id);
    if (!status) {
      throw new NeweggApiError(
        "Newegg returned no status for the requested courtesy refund request.",
        {
          correlationId: result.correlationId,
          details: { requestId: id },
        },
      );
    }
    return status;
  }
}
