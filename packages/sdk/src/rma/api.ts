import { randomUUID } from "node:crypto";
import type {
  EditRmaInput,
  ListRmasInput,
  OrdersApi,
  ProcessRmaInput,
  RefundsApi,
  RejectRmaInput,
  RequestOptions,
  Rma,
  RmaApi,
  RmasPage,
  RmaWriteResult,
  ServiceWriteOperation,
  ServiceWritePreview,
  SubmitRmaInput,
} from "../types.js";
import type { RequestSpec } from "../platform/index.js";
import type { NeweggHttpClient } from "../client/http.js";
import { NeweggApiError, NeweggValidationError } from "../errors/index.js";
import { Operation } from "../client/operations.js";
import { getRmaPlatform, resolveRmaVersion } from "../platform/rma.js";
import { rateLimitKey } from "../rate-limit/index.js";
import {
  assertNoBlockers,
  buildPreview,
  indeterminateServiceWrite,
  loadOrderContext,
  sendServiceWrite,
  type ServiceWriteReaders,
} from "../servicemgmt/write.js";
import { RMA_INFO_PATH } from "./constants.js";
import { buildRmaInfoRequest, parseRmaResponse } from "./parse.js";
import {
  checkOrderEligibility,
  checkRmaItems,
  checkRmaState,
  newFindings,
  rmaRefundCents,
  warnAboutExisting,
} from "./write-checks.js";
import { RMA_SUBMIT_PATH, RMA_UPDATE_PATH, fromCents } from "./write-constants.js";
import {
  normalizeEditRma,
  normalizeProcessRma,
  normalizeRejectRma,
  normalizeSubmitRma,
} from "./write-validate.js";
import {
  buildEditRmaBody,
  buildReceiveRmaBody,
  buildRejectRmaBody,
  buildSubmitRmaBody,
  parseRmaWriteResponse,
  rejectReasonCode,
} from "./write-wire.js";

type RmaWriteKind = Exclude<ServiceWriteOperation, "refunds.issue">;

/**
 * RMA reads (contracts §18.1): Get RMA Information, a READ via PUT (1000 req/hr). `get`/`tryGet`
 * are a keyword search on the RMA number. RMA WRITES (contracts §20: Submit 100/hr; Edit, Process
 * (receive) and Reject 1000/hr) are NON-idempotent POSTs: each has a read-only `preview*` twin, the
 * write re-runs the same checks and refuses on any blocker, and an ambiguous failure throws
 * `IndeterminateServiceWriteError` and is never resent (ADR 0004).
 */
export class RmaApiImpl implements RmaApi {
  readonly #http: NeweggHttpClient;
  readonly #readers: ServiceWriteReaders;

  constructor(http: NeweggHttpClient, orders: OrdersApi, refunds: () => RefundsApi) {
    this.#http = http;
    this.#readers = { orders, rma: () => this, refunds };
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

  // --------------------------------------------------------------------------------------------
  // writes (contracts §20)
  // --------------------------------------------------------------------------------------------
  async previewSubmit(
    input: SubmitRmaInput,
    options: RequestOptions = {},
  ): Promise<ServiceWritePreview<SubmitRmaInput>> {
    return this.#planSubmit(input, options);
  }

  async submit(input: SubmitRmaInput, options: RequestOptions = {}): Promise<RmaWriteResult> {
    const preview = await this.#planSubmit(input, options);
    assertNoBlockers("Submit RMA", preview.blockers);
    return this.#write({
      operation: "rma.submit",
      key: Operation.RmaSubmit,
      path: RMA_SUBMIT_PATH,
      body: buildSubmitRmaBody(preview.normalized),
      orderNumber: String(preview.normalized.orderNumber),
      correlationId: preview.correlationId,
      options,
    });
  }

  async previewEdit(
    input: EditRmaInput,
    options: RequestOptions = {},
  ): Promise<ServiceWritePreview<EditRmaInput>> {
    return this.#planEdit(input, options);
  }

  async edit(input: EditRmaInput, options: RequestOptions = {}): Promise<RmaWriteResult> {
    const preview = await this.#planEdit(input, options);
    assertNoBlockers("Edit RMA", preview.blockers);
    return this.#write({
      operation: "rma.edit",
      key: Operation.RmaEdit,
      path: RMA_UPDATE_PATH,
      body: buildEditRmaBody(preview.normalized),
      orderNumber: preview.orderNumber,
      rmaNumber: String(preview.normalized.rmaNumber),
      correlationId: preview.correlationId,
      options,
    });
  }

  async previewProcess(
    input: ProcessRmaInput,
    options: RequestOptions = {},
  ): Promise<ServiceWritePreview<ProcessRmaInput>> {
    return this.#planProcess(input, options);
  }

  async process(input: ProcessRmaInput, options: RequestOptions = {}): Promise<RmaWriteResult> {
    const preview = await this.#planProcess(input, options);
    assertNoBlockers("Process RMA", preview.blockers);
    return this.#write({
      operation: "rma.receive",
      key: Operation.RmaReceive,
      path: RMA_UPDATE_PATH,
      body: buildReceiveRmaBody(preview.normalized),
      orderNumber: preview.orderNumber,
      rmaNumber: String(preview.normalized.rmaNumber),
      correlationId: preview.correlationId,
      options,
    });
  }

  async previewReject(
    input: RejectRmaInput,
    options: RequestOptions = {},
  ): Promise<ServiceWritePreview<RejectRmaInput>> {
    return this.#planReject(input, options);
  }

  async reject(input: RejectRmaInput, options: RequestOptions = {}): Promise<RmaWriteResult> {
    const preview = await this.#planReject(input, options);
    assertNoBlockers("Reject RMA", preview.blockers);
    const platform = getRmaPlatform(this.#http.config.marketplace);
    return this.#write({
      operation: "rma.reject",
      key: Operation.RmaReject,
      path: RMA_UPDATE_PATH,
      body: buildRejectRmaBody(preview.normalized, rejectReasonCode(preview.normalized, platform)),
      orderNumber: preview.orderNumber,
      rmaNumber: String(preview.normalized.rmaNumber),
      correlationId: preview.correlationId,
      options,
    });
  }

  async #planSubmit(
    input: SubmitRmaInput,
    options: RequestOptions,
  ): Promise<ServiceWritePreview<SubmitRmaInput>> {
    const platform = getRmaPlatform(this.#http.config.marketplace);
    const normalized = normalizeSubmitRma(input, platform);
    const correlationId = options.correlationId ?? randomUUID();
    const orderNumber = String(normalized.orderNumber);
    const findings = newFindings();
    const context = await loadOrderContext(
      this.#readers,
      orderNumber,
      { ...options, correlationId },
      findings,
    );
    checkOrderEligibility(context.order, findings);
    warnAboutExisting(context, findings);
    const cents = checkRmaItems({
      type: normalized.type,
      items: normalized.items,
      context,
      findings,
    });
    if (normalized.type === "replacement") {
      findings.warnings.push(
        "Newegg requires DiffShippedByPartyAction on a replacement RMA for an order with both Shipped-by-Seller and Shipped-by-Newegg items; the SDK does not send it and cannot detect such an order, so Newegg may reject this.",
      );
    }
    if (normalized.autoReceive === true) {
      findings.warnings.push(
        "autoReceive finalizes the refund in the same call; it is refused for Newegg-fulfilled orders (SE031).",
      );
      if (context.order?.fulfillment === "newegg") {
        findings.blockers.push(
          "Auto-receive is unavailable for orders processed by Newegg (SE031).",
        );
      }
    }
    return buildPreview({
      http: this.#http,
      operation: "rma.submit",
      normalized,
      currency: platform.currency,
      findings,
      correlationId,
      refundTotal: normalized.type === "refund" ? fromCents(cents) : undefined,
      orderNumber,
    });
  }

  async #planEdit(
    input: EditRmaInput,
    options: RequestOptions,
  ): Promise<ServiceWritePreview<EditRmaInput>> {
    const platform = getRmaPlatform(this.#http.config.marketplace);
    const normalized = normalizeEditRma(input, platform);
    const correlationId = options.correlationId ?? randomUUID();
    const readOptions = { ...options, correlationId };
    const findings = newFindings();
    const rmaNumber = String(normalized.rmaNumber);
    const rma = await this.tryGet(rmaNumber, readOptions);
    checkRmaState(rma, findings);
    let orderNumber: string | undefined;
    let refundCents = 0;
    if (rma !== undefined) {
      if (rma.type !== normalized.type) {
        findings.blockers.push(`The RMA is a ${rma.type} RMA; its type cannot be changed.`);
      }
      orderNumber = rma.orderNumber;
      if (orderNumber === undefined) {
        findings.blockers.push(
          "Newegg reported no order number for the RMA, so it could not be checked.",
        );
      } else {
        const context = await loadOrderContext(this.#readers, orderNumber, readOptions, findings);
        if (context.order === undefined) {
          findings.blockers.push("Newegg returned no such order for this seller.");
        }
        warnAboutExisting(context, findings, rmaNumber);
        refundCents = checkRmaItems({
          type: normalized.type,
          items: normalized.items,
          context,
          findings,
          excludeRmaNumber: rmaNumber,
        });
      }
      const kept = new Set(normalized.items.map((item) => item.sellerPartNumber));
      const dropped = rma.items
        .map((item) => item.sellerPartNumber)
        .filter((part): part is string => part !== undefined && !kept.has(part));
      if (dropped.length > 0) {
        findings.warnings.push(
          `The edit sends only the supplied lines; these existing lines are not in it: ${dropped.join(", ")}.`,
        );
      }
      const before = rmaRefundCents(rma);
      if (normalized.type === "refund" && before > 0) {
        findings.warnings.push(
          `The RMA currently refunds ${fromCents(before).toFixed(2)}; the edit sets it to ${fromCents(
            refundCents,
          ).toFixed(2)}.`,
        );
      }
    }
    return buildPreview({
      http: this.#http,
      operation: "rma.edit",
      normalized,
      currency: platform.currency,
      findings,
      correlationId,
      refundTotal: normalized.type === "refund" ? fromCents(refundCents) : undefined,
      orderNumber,
    });
  }

  async #planProcess(
    input: ProcessRmaInput,
    options: RequestOptions,
  ): Promise<ServiceWritePreview<ProcessRmaInput>> {
    const platform = getRmaPlatform(this.#http.config.marketplace);
    const normalized = normalizeProcessRma(input);
    const correlationId = options.correlationId ?? randomUUID();
    const findings = newFindings();
    const rma = await this.tryGet(String(normalized.rmaNumber), { ...options, correlationId });
    checkRmaState(rma, findings);
    let refundTotal: number | undefined;
    if (rma !== undefined && rma.type === "unknown") {
      findings.blockers.push(
        "Newegg reported no readable type for the RMA, so the refund it would release cannot be checked.",
      );
    }
    if (rma !== undefined && rma.type === "refund") {
      const cents = rmaRefundCents(rma);
      refundTotal = fromCents(cents);
      findings.warnings.push(
        cents > 0
          ? `Receiving this refund RMA is expected to refund the customer ${refundTotal.toFixed(2)} ${platform.currency}.`
          : "This is a refund RMA but its refund amounts could not be read; receiving it is expected to refund the customer.",
      );
    }
    return buildPreview({
      http: this.#http,
      operation: "rma.receive",
      normalized,
      currency: platform.currency,
      findings,
      correlationId,
      refundTotal,
      orderNumber: rma?.orderNumber,
    });
  }

  async #planReject(
    input: RejectRmaInput,
    options: RequestOptions,
  ): Promise<ServiceWritePreview<RejectRmaInput>> {
    const platform = getRmaPlatform(this.#http.config.marketplace);
    const normalized = normalizeRejectRma(input, platform);
    const correlationId = options.correlationId ?? randomUUID();
    const findings = newFindings();
    const rma = await this.tryGet(String(normalized.rmaNumber), { ...options, correlationId });
    checkRmaState(rma, findings);
    if (rma !== undefined) {
      findings.warnings.push(
        "Rejecting denies the customer's return and refund; the item must be shipped back with the tracking number given.",
      );
    }
    return buildPreview({
      http: this.#http,
      operation: "rma.reject",
      normalized,
      currency: platform.currency,
      findings,
      correlationId,
      orderNumber: rma?.orderNumber,
    });
  }

  async #write(args: {
    operation: RmaWriteKind;
    key: string;
    path: string;
    body: unknown;
    orderNumber?: string;
    rmaNumber?: string;
    correlationId: string;
    options: RequestOptions;
  }): Promise<RmaWriteResult> {
    const { marketplace, sellerId } = this.#http.config;
    const platform = getRmaPlatform(marketplace);
    const spec: RequestSpec = {
      method: "POST",
      path: `${this.#http.adapter.prefix}${args.path}`,
      query: { version: platform.writeVersion },
      body: args.body,
    };
    const ctx = {
      operation: args.key,
      correlationId: args.correlationId,
      signal: args.options.signal,
      timeoutMs: args.options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, args.key),
    };
    const meta = {
      operation: args.operation,
      orderNumber: args.orderNumber,
      rmaNumber: args.rmaNumber,
    };
    const { result, submittedAtIso } = await sendServiceWrite(this.#http, spec, ctx, meta);
    const rma = parseRmaWriteResponse(result.json, args.correlationId);
    if (
      rma.rmaNumber === "" ||
      (args.rmaNumber !== undefined && rma.rmaNumber !== args.rmaNumber)
    ) {
      throw indeterminateServiceWrite(
        this.#http,
        ctx,
        meta,
        "Newegg answered the write with a success status but the response does not identify the RMA, so the outcome is unknown.",
        submittedAtIso,
      );
    }
    return {
      marketplace,
      operation: args.operation,
      rmaNumber: rma.rmaNumber,
      type: rma.type,
      status: rma.status,
      statusDescription: rma.statusDescription,
      sellerRmaNumber: rma.sellerRmaNumber,
      orderNumber: rma.orderNumber ?? args.orderNumber,
      note: rma.note,
      items: rma.items,
      currency: platform.currency,
      correlationId: args.correlationId,
      rateLimit: result.rateLimit,
      raw: args.options.includeRaw ? result.json : undefined,
    };
  }
}
