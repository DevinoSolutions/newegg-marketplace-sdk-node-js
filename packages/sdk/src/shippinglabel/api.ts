import { createHash, randomUUID } from "node:crypto";
import type {
  OrdersApi,
  RequestOptions,
  LabelCreateAttempt,
  ShippingLabelCreateOptions,
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
import {
  IndeterminateOrderWriteError,
  NeweggApiError,
  NeweggError,
  NeweggValidationError,
} from "../errors/index.js";
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
import { LabelCreateGuardError, priorAttemptMessage } from "./guard-error.js";
import { isMarkedNotBought, LabelCreateLedger, markNotBought } from "./ledger.js";
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

/**
 * Why a supplied acknowledgement does not clear `attempt`, or undefined when none was supplied or
 * it names exactly this attempt.
 */
function rejectedAcknowledgement(
  options: ShippingLabelCreateOptions,
  attempt: LabelCreateAttempt,
): string | undefined {
  const given = options.acknowledgePriorAttemptId;
  if (given === undefined || given === attempt.attemptId) return undefined;
  return "The acknowledgement names a different attempt than the latest one, so it was not accepted.";
}

/**
 * True when the failure proves no label was bought: the request never left (marked in `send.ts`),
 * Newegg refused every package, or it answered with an HTTP 4xx. Anything else, an indeterminate
 * outcome above all, keeps blocking.
 */
function isDefinitelyNotBought(error: unknown): boolean {
  if (error instanceof IndeterminateOrderWriteError) return false;
  if (isMarkedNotBought(error)) return true;
  return (
    error instanceof NeweggError &&
    error.httpStatus !== undefined &&
    error.httpStatus >= 400 &&
    error.httpStatus <= 499 &&
    error.httpStatus !== 408
  );
}

/** Longest Newegg error text echoed into an SDK error message. */
const MAX_ERROR_TEXT = 300;

function clip(text: string): string {
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}...` : text;
}

/**
 * Newegg Shipping Label Service (contracts §23). `estimate` is a quote. `create` and `reprint` are
 * NON-idempotent POSTs routed through {@link sendLabelWrite}, which never resends once the request
 * may have been dispatched (ADR 0004); each has a read-only `preview*` twin and re-runs the same
 * checks, refusing on any blocker. A `create` is also recorded per order in a ledger (see
 * `ledger.ts`, built on the client's OperationStore) and a second one is refused while the first
 * is indeterminate or succeeded (T-6212). Nothing here is verified live: no label may be bought to
 * test it.
 */
export class ShippingLabelsApiImpl implements ShippingLabelsApi {
  readonly #http: NeweggHttpClient;
  readonly #orders: OrdersApi;
  readonly #ledger: LabelCreateLedger;

  constructor(http: NeweggHttpClient, orders: OrdersApi) {
    this.#http = http;
    this.#orders = orders;
    this.#ledger = new LabelCreateLedger(http.config.operationStore);
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
    options: ShippingLabelCreateOptions = {},
  ): Promise<ShippingLabelPreview<ShippingLabelInput>> {
    return (await this.#planCreate(input, options)).preview;
  }

  async create(
    input: ShippingLabelInput,
    options: ShippingLabelCreateOptions = {},
  ): Promise<ShippingLabelResult> {
    const { marketplace, sellerId } = this.#http.config;
    const {
      preview: plan,
      attempt,
      acknowledged,
      guardMessage,
    } = await this.#planCreate(input, options);
    const { normalized, correlationId } = plan;
    const orderNumber = String(normalized.orderNumber);
    if (attempt !== undefined && !acknowledged) {
      throw new LabelCreateGuardError(
        guardMessage ??
          priorAttemptMessage(orderNumber, attempt, undefined, options.priorAttemptGuidance),
        orderNumber,
        attempt,
      );
    }
    this.#assertNoBlockers("The shipping label purchase", plan.blockers);
    const spec: RequestSpec = {
      method: "POST",
      path: `${this.#http.adapter.prefix}${SHIPPING_LABEL_CREATE_PATH}`,
      body: buildCreateLabelBody(normalized, sellerId),
    };
    const ctx = this.#context(Operation.ShippingLabelCreate, correlationId, options);
    const meta = { operation: Operation.ShippingLabelCreate, orderNumber };

    // Record the attempt BEFORE dispatch, with nothing awaited between the check and the record:
    // a concurrent create of the same order is refused here, and a record that cannot be written
    // stops the purchase (nothing is sent without its trace).
    const ledgerKey = LabelCreateLedger.key(marketplace, orderNumber);
    const attemptId = randomUUID();
    const claim = this.#ledger.claim(
      ledgerKey,
      attemptId,
      createHash("sha256").update(JSON.stringify(spec.body), "utf8").digest("hex"),
      acknowledged ? attempt?.attemptId : undefined,
    );
    if ("refused" in claim) {
      throw new LabelCreateGuardError(
        priorAttemptMessage(orderNumber, claim.refused, undefined, options.priorAttemptGuidance),
        orderNumber,
        claim.refused,
      );
    }
    try {
      await this.#ledger.persist(ledgerKey, claim.op);
    } catch (cause) {
      this.#ledger.rollback(ledgerKey, claim);
      throw new NeweggApiError(
        "The label attempt could not be recorded in the operation store, so nothing was sent.",
        { correlationId, retryable: false, cause },
      );
    }
    try {
      const created = await this.#dispatchCreate(spec, ctx, meta, plan.currency, options);
      await this.#ledger.settle(ledgerKey, attemptId, "submitted");
      return created;
    } catch (error) {
      // Only a request that provably bought nothing frees the order for a new create; an
      // indeterminate or unrecognised failure leaves the record at `submitting`.
      if (isDefinitelyNotBought(error)) await this.#ledger.settle(ledgerKey, attemptId, "failed");
      throw error;
    }
  }

  async #dispatchCreate(
    spec: RequestSpec,
    ctx: RequestContext,
    meta: { operation: string; orderNumber: string },
    currency: ShippingLabelResult["currency"],
    options: RequestOptions,
  ): Promise<ShippingLabelResult> {
    const { marketplace } = this.#http.config;
    const { correlationId } = ctx;
    const { orderNumber } = meta;
    const { result, submittedAtIso } = await sendLabelWrite(this.#http, spec, ctx, meta);
    const parsed = parseCreateLabelResponse(result.json, correlationId);
    const succeeded = parsed.packages.filter((pkg) => pkg.succeeded);
    const failed = parsed.packages.filter((pkg) => !pkg.succeeded);
    const allExplicitlyFailed = parsed.packages.every(
      (pkg, index) =>
        pkg.succeeded ||
        (parsed.explicitFailures[index] === true && pkg.errorMessage !== undefined),
    );
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
      // A refusal is definitive only when Newegg plainly says the package failed AND why. A
      // package that is Pending, carries an unfamiliar status, or has no error text is neither a
      // success nor a stated failure, so a label may exist (and an error text next to a Pending
      // status is not a refusal either).
      if (!allExplicitlyFailed) {
        throw indeterminateLabelWrite(
          this.#http,
          ctx,
          meta,
          "Newegg answered the label request with a success status but a package with neither a label nor a plain failure with a reason, so whether a label was bought is unknown.",
          submittedAtIso,
        );
      }
      const reasons = failed
        .map((pkg) => pkg.errorMessage)
        .filter((message): message is string => message !== undefined)
        .map(clip);
      throw markNotBought(
        new NeweggApiError(
          `Newegg refused every package of the label request${reasons.length > 0 ? `: ${reasons.join("; ")}` : "."}`,
          { correlationId, retryable: false },
        ),
      );
    }
    return {
      marketplace,
      operation: "shippingLabels.create",
      orderNumber: parsed.orderNumber || orderNumber,
      shipDate: parsed.shipDate,
      currency,
      packages: parsed.packages,
      succeededCount: succeeded.length,
      failedCount: failed.length,
      totalCharged: succeeded.reduce((sum, pkg) => sum + (pkg.rate?.total ?? 0), 0),
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async assertCreateNotBlocked(
    orderNumber: string | number,
    options: Pick<ShippingLabelCreateOptions, "priorAttemptGuidance"> = {},
  ): Promise<void> {
    const { marketplace } = this.#http.config;
    const number = normalizeReprintInput(orderNumber).orderNumber;
    const attempt = await this.#ledger.read(LabelCreateLedger.key(marketplace, number));
    if (attempt !== undefined) {
      throw new LabelCreateGuardError(
        priorAttemptMessage(number, attempt, undefined, options.priorAttemptGuidance),
        number,
        attempt,
      );
    }
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

  /**
   * The create plan: the order checks plus the ledger. `attempt` is the earlier create that blocks
   * (or, when `acknowledged`, was explicitly cleared by the caller for this one).
   */
  async #planCreate(
    input: ShippingLabelInput,
    options: ShippingLabelCreateOptions,
  ): Promise<{
    preview: ShippingLabelPreview<ShippingLabelInput>;
    attempt: LabelCreateAttempt | undefined;
    acknowledged: boolean;
    /** The ledger blocker text when `attempt` blocks. */
    guardMessage: string | undefined;
  }> {
    const { marketplace } = this.#http.config;
    const platform = getShippingLabelPlatform(marketplace);
    const normalized = normalizeShippingLabelInput(input, platform);
    const correlationId = options.correlationId ?? randomUUID();
    const orderNumber = String(normalized.orderNumber);
    const findings = newLabelFindings();
    const order = await this.#readOrder(orderNumber, { ...options, correlationId }, findings);
    checkCreateAgainstOrder(order, normalized, platform, findings);

    const attempt = await this.#ledger.read(LabelCreateLedger.key(marketplace, orderNumber));
    let acknowledged = false;
    let guardMessage: string | undefined;
    if (attempt !== undefined) {
      const rejected = rejectedAcknowledgement(options, attempt);
      const listed = order?.packages.length ?? 0;
      const guidance = options.priorAttemptGuidance;
      if (rejected !== undefined) {
        guardMessage = priorAttemptMessage(orderNumber, attempt, rejected, guidance);
      } else if (options.acknowledgePriorAttemptId !== undefined && listed > 0) {
        guardMessage = priorAttemptMessage(
          orderNumber,
          attempt,
          `The acknowledgement was not accepted because the order already lists ${listed} package(s).`,
          guidance,
        );
      } else if (options.acknowledgePriorAttemptId !== undefined) {
        acknowledged = true;
        findings.warnings.push(
          `Prior label create attempt ${attempt.attemptId} (${attempt.state}) was acknowledged by the caller: ` +
            "the order shows no package, so this create may buy a SECOND label if the earlier one did land.",
        );
      } else {
        guardMessage = priorAttemptMessage(orderNumber, attempt, undefined, guidance);
      }
      if (guardMessage !== undefined) findings.blockers.push(guardMessage);
    }
    const preview = this.#preview(
      "shippingLabels.create",
      normalized,
      orderNumber,
      findings,
      correlationId,
    );
    return {
      preview: attempt === undefined ? preview : { ...preview, priorAttempt: attempt },
      attempt,
      acknowledged,
      guardMessage,
    };
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
