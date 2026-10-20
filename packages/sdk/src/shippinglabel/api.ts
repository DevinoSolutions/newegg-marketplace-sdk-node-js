import { randomUUID } from "node:crypto";
import type {
  OrdersApi,
  RequestOptions,
  ShippingLabelEstimate,
  ShippingLabelInput,
  ShippingLabelPreview,
  ShippingLabelReprintInput,
  ShippingLabelReprintResult,
  ShippingLabelResult,
  ShippingLabelsApi,
  ShippingLabelWriteOperation,
} from "../types.js";
import type { RequestSpec } from "../platform/index.js";
import type { NeweggHttpClient, RequestContext } from "../client/http.js";
import { NeweggApiError, NeweggValidationError } from "../errors/index.js";
import { Operation } from "../client/operations.js";
import { getShippingLabelPlatform } from "../platform/shipping-label.js";
import { rateLimitKey } from "../rate-limit/index.js";
import {
  SHIPPING_LABEL_CREATE_PATH,
  SHIPPING_LABEL_ESTIMATE_PATH,
  SHIPPING_LABEL_REPRINT_PATH,
} from "./constants.js";
import {
  checkCreateAgainstOrder,
  checkReprintAgainstOrder,
  newLabelFindings,
  type LabelFindings,
} from "./checks.js";
import { indeterminateLabelWrite, sendLabelWrite } from "./send.js";
import { normalizeReprintInput, normalizeShippingLabelInput } from "./validate.js";
import {
  buildCreateLabelBody,
  buildEstimateLabelBody,
  buildReprintLabelBody,
  parseCreateLabelResponse,
  parseEstimateLabelResponse,
  parseReprintLabelResponse,
} from "./wire.js";

/** Longest Newegg error text echoed into an SDK error message. */
const MAX_ERROR_TEXT = 300;

function clip(text: string): string {
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}...` : text;
}

/**
 * Newegg Shipping Label Service (contracts §23). `estimate` is a quote. `create` and `reprint` are
 * NON-idempotent POSTs routed through {@link sendLabelWrite}, which never resends once the request
 * may have been dispatched (ADR 0004); each has a read-only `preview*` twin and re-runs the same
 * checks, refusing on any blocker. Nothing here is verified live: no label may be bought to test it.
 */
export class ShippingLabelsApiImpl implements ShippingLabelsApi {
  readonly #http: NeweggHttpClient;
  readonly #orders: OrdersApi;

  constructor(http: NeweggHttpClient, orders: OrdersApi) {
    this.#http = http;
    this.#orders = orders;
  }

  async estimate(
    input: ShippingLabelInput,
    options: RequestOptions = {},
  ): Promise<ShippingLabelEstimate> {
    const { marketplace, sellerId } = this.#http.config;
    const platform = getShippingLabelPlatform(marketplace);
    const normalized = normalizeShippingLabelInput(input, platform);
    const correlationId = options.correlationId ?? randomUUID();
    const spec: RequestSpec = {
      method: "POST",
      path: `${this.#http.adapter.prefix}${SHIPPING_LABEL_ESTIMATE_PATH}`,
      body: buildEstimateLabelBody(normalized, sellerId),
    };
    // A single attempt: the estimate is not proven side-effect free (contracts §23.6), so a
    // timeout or 5xx is reported rather than silently resent.
    const result = await this.#http.requestOnce(spec, {
      operation: Operation.ShippingLabelEstimate,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.ShippingLabelEstimate),
    });
    const parsed = parseEstimateLabelResponse(result.json, correlationId);
    if (parsed.packages.length === 0) {
      throw new NeweggApiError("Newegg answered the estimate without any package quote.", {
        correlationId,
      });
    }
    return {
      marketplace,
      orderNumber: parsed.orderNumber || String(normalized.orderNumber),
      estimatedDate: parsed.estimatedDate,
      currency: platform.currency,
      packages: parsed.packages,
      estimatedTotal: parsed.estimatedTotal,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async previewCreate(
    input: ShippingLabelInput,
    options: RequestOptions = {},
  ): Promise<ShippingLabelPreview<ShippingLabelInput>> {
    return this.#planCreate(input, options);
  }

  async create(
    input: ShippingLabelInput,
    options: RequestOptions = {},
  ): Promise<ShippingLabelResult> {
    const { marketplace, sellerId } = this.#http.config;
    const plan = await this.#planCreate(input, options);
    this.#assertNoBlockers("The shipping label purchase", plan.blockers);
    const { normalized, correlationId } = plan;
    const orderNumber = String(normalized.orderNumber);
    const spec: RequestSpec = {
      method: "POST",
      path: `${this.#http.adapter.prefix}${SHIPPING_LABEL_CREATE_PATH}`,
      body: buildCreateLabelBody(normalized, sellerId),
    };
    const ctx = this.#context(Operation.ShippingLabelCreate, correlationId, options);
    const meta = { operation: Operation.ShippingLabelCreate, orderNumber };
    const { result, submittedAtIso } = await sendLabelWrite(this.#http, spec, ctx, meta);
    const parsed = parseCreateLabelResponse(result.json, correlationId);
    const succeeded = parsed.packages.filter((pkg) => pkg.succeeded);
    const failed = parsed.packages.filter((pkg) => !pkg.succeeded);
    if (parsed.packages.length === 0) {
      throw indeterminateLabelWrite(
        this.#http,
        ctx,
        meta,
        "Newegg answered the label request with a success status but no package, so whether a label was bought is unknown.",
        submittedAtIso,
      );
    }
    if (succeeded.length === 0) {
      // A refusal is definitive only when Newegg says why. A package with no tracking number, no
      // link and no error text is neither a success nor a stated failure, so a label may exist.
      if (failed.some((pkg) => pkg.errorMessage === undefined)) {
        throw indeterminateLabelWrite(
          this.#http,
          ctx,
          meta,
          "Newegg answered the label request with a success status but a package with neither a label nor an error, so whether a label was bought is unknown.",
          submittedAtIso,
        );
      }
      const reasons = failed
        .map((pkg) => pkg.errorMessage)
        .filter((message): message is string => message !== undefined)
        .map(clip);
      throw new NeweggApiError(
        `Newegg refused every package of the label request${reasons.length > 0 ? `: ${reasons.join("; ")}` : "."}`,
        { correlationId, retryable: false },
      );
    }
    return {
      marketplace,
      operation: "shippingLabels.create",
      orderNumber: parsed.orderNumber || orderNumber,
      shipDate: parsed.shipDate,
      currency: plan.currency,
      packages: parsed.packages,
      succeededCount: succeeded.length,
      failedCount: failed.length,
      totalCharged: succeeded.reduce((sum, pkg) => sum + (pkg.rate?.total ?? 0), 0),
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async previewReprint(
    orderNumber: string | number,
    options: RequestOptions = {},
  ): Promise<ShippingLabelPreview<ShippingLabelReprintInput>> {
    return this.#planReprint(orderNumber, options);
  }

  async reprint(
    orderNumber: string | number,
    options: RequestOptions = {},
  ): Promise<ShippingLabelReprintResult> {
    const { marketplace, sellerId } = this.#http.config;
    const plan = await this.#planReprint(orderNumber, options);
    this.#assertNoBlockers("The shipping label reprint", plan.blockers);
    const { correlationId } = plan;
    const number = plan.normalized.orderNumber;
    const spec: RequestSpec = {
      method: "POST",
      path: `${this.#http.adapter.prefix}${SHIPPING_LABEL_REPRINT_PATH}`,
      body: buildReprintLabelBody(number, sellerId),
    };
    const ctx = this.#context(Operation.ShippingLabelReprint, correlationId, options);
    const meta = { operation: Operation.ShippingLabelReprint, orderNumber: number };
    const { result, submittedAtIso } = await sendLabelWrite(this.#http, spec, ctx, meta);
    const parsed = parseReprintLabelResponse(result.json, correlationId);
    if (
      parsed.packages.length === 0 ||
      (parsed.orderNumber !== "" && parsed.orderNumber !== number)
    ) {
      throw indeterminateLabelWrite(
        this.#http,
        ctx,
        meta,
        "Newegg answered the reprint with a success status but the response does not carry this order's label, so the outcome is unknown.",
        submittedAtIso,
      );
    }
    return {
      marketplace,
      operation: "shippingLabels.reprint",
      orderNumber: parsed.orderNumber || number,
      orderStatus: parsed.orderStatus,
      packages: parsed.packages,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  #context(operation: string, correlationId: string, options: RequestOptions): RequestContext {
    const { marketplace, sellerId } = this.#http.config;
    return {
      operation,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, operation),
    };
  }

  #assertNoBlockers(label: string, blockers: readonly string[]): void {
    if (blockers.length === 0) return;
    throw new NeweggValidationError(
      `${label} was not sent: ${blockers.join(" ")}`,
      blockers.map((message) => ({ path: "preflight", message })),
    );
  }

  /** Reads (only) the order; the same checks guard the preview and the write. */
  async #readOrder(orderNumber: string, options: RequestOptions, findings: LabelFindings) {
    const order = await this.#orders.tryGet(orderNumber, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      correlationId: options.correlationId,
    });
    if (order !== undefined && order.orderNumber !== "" && order.orderNumber !== orderNumber) {
      findings.blockers.push("Newegg returned a different order than the one requested.");
    }
    return order;
  }

  #preview<N>(
    operation: ShippingLabelWriteOperation,
    normalized: N,
    orderNumber: string,
    findings: LabelFindings,
    correlationId: string,
  ): ShippingLabelPreview<N> {
    const { marketplace } = this.#http.config;
    return {
      marketplace,
      operation,
      normalized,
      currency: getShippingLabelPlatform(marketplace).currency,
      orderNumber,
      blockers: findings.blockers,
      warnings: findings.warnings,
      correlationId,
    };
  }

  async #planCreate(
    input: ShippingLabelInput,
    options: RequestOptions,
  ): Promise<ShippingLabelPreview<ShippingLabelInput>> {
    const platform = getShippingLabelPlatform(this.#http.config.marketplace);
    const normalized = normalizeShippingLabelInput(input, platform);
    const correlationId = options.correlationId ?? randomUUID();
    const orderNumber = String(normalized.orderNumber);
    const findings = newLabelFindings();
    const order = await this.#readOrder(orderNumber, { ...options, correlationId }, findings);
    checkCreateAgainstOrder(order, normalized, platform, findings);
    return this.#preview("shippingLabels.create", normalized, orderNumber, findings, correlationId);
  }

  async #planReprint(
    orderNumber: string | number,
    options: RequestOptions,
  ): Promise<ShippingLabelPreview<ShippingLabelReprintInput>> {
    const normalized = normalizeReprintInput(orderNumber);
    const correlationId = options.correlationId ?? randomUUID();
    const findings = newLabelFindings();
    const order = await this.#readOrder(
      normalized.orderNumber,
      { ...options, correlationId },
      findings,
    );
    checkReprintAgainstOrder(order, findings);
    return this.#preview(
      "shippingLabels.reprint",
      normalized,
      normalized.orderNumber,
      findings,
      correlationId,
    );
  }
}
