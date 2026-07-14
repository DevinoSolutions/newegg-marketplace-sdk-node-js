import { randomUUID } from "node:crypto";
import type {
  CancelOrderInput,
  CancelOrderResult,
  ConfirmOrdersInput,
  ConfirmOrdersResult,
  ListOrdersInput,
  Order,
  OrdersApi,
  OrdersPage,
  OrderStatusSnapshot,
  RemoveOrderItemsInput,
  RemoveOrderItemsResult,
  RequestOptions,
  ShipOrderInput,
  ShipOrderResult,
} from "../types.js";
import type { RequestSpec } from "../platform/index.js";
import type { HttpResult, NeweggHttpClient, RequestContext } from "../client/http.js";
import { IndeterminateOrderWriteError, NeweggApiError, NeweggError } from "../errors/index.js";
import { Operation } from "../client/operations.js";
import { fullJitterDelay } from "../client/retry.js";
import { TransportError } from "../client/transport.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { delay, isAbortError } from "../util.js";
import {
  ORDER_INFO_VERSION,
  ORDER_NOT_FOUND_ERROR_CODES,
  ORDER_STATUS_VERSION,
  ORDER_WRITE_VERSION,
} from "./constants.js";
import {
  buildCancelRequest,
  buildConfirmRequest,
  buildOrderInfoRequest,
  buildRemoveItemsRequest,
  buildShipRequest,
  parseCancelResponse,
  parseConfirmResponse,
  parseOrderStatus,
  parseOrdersResponse,
  parseRemoveItemsResponse,
  parseShipResponse,
} from "./parse.js";

/** HTTP statuses ambiguous after dispatch (the write may or may not have mutated). */
const ORDER_WRITE_AMBIGUOUS_STATUSES = new Set([408, 502, 503, 504]);

/**
 * Orders API. Reads: order search (`list`), single-order detail (`get`/`tryGet`), and a
 * lightweight status check (`getStatus`/`tryGetStatus`) — `list`/`get` share Get Order
 * Information (1000 req/hr), `getStatus` uses Get Order Status (500 req/hr). Writes (§11):
 * `ship`/`cancel`/`confirmDownload`/`removeItems`, each NON-idempotent — routed through
 * the internal `#sendWrite` helper, which never resends after an ambiguous dispatch failure.
 */
export class OrdersApiImpl implements OrdersApi {
  readonly #http: NeweggHttpClient;

  constructor(http: NeweggHttpClient) {
    this.#http = http;
  }

  get #config() {
    return this.#http.config;
  }

  async list(input: ListOrdersInput = {}, options: RequestOptions = {}): Promise<OrdersPage> {
    const { marketplace, sellerId } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const { body, pageIndex, pageSize } = buildOrderInfoRequest(input);
    const spec: RequestSpec = {
      method: "PUT",
      path: `${this.#http.adapter.prefix}ordermgmt/order/orderinfo`,
      query: { version: ORDER_INFO_VERSION },
      body,
    };
    const result = await this.#http.request(spec, {
      operation: Operation.OrderList,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.OrderList),
    });
    const parsed = parseOrdersResponse(result.json);
    return {
      marketplace,
      orders: parsed.orders,
      page: parsed.page.pageIndex || pageIndex,
      pageSize: parsed.page.pageSize || pageSize,
      totalCount: parsed.page.totalCount,
      totalPageCount: parsed.page.totalPageCount,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async get(orderNumber: string | number, options: RequestOptions = {}): Promise<Order> {
    const page = await this.list({ orderNumbers: [orderNumber], pageSize: 1 }, options);
    const order = page.orders[0];
    if (!order) {
      throw new NeweggApiError("Newegg returned no order for the requested order number.", {
        correlationId: page.correlationId,
        details: { orderNumber: String(orderNumber) },
      });
    }
    return order;
  }

  async tryGet(
    orderNumber: string | number,
    options: RequestOptions = {},
  ): Promise<Order | undefined> {
    const page = await this.list({ orderNumbers: [orderNumber], pageSize: 1 }, options);
    return page.orders[0];
  }

  async getStatus(
    orderNumber: string | number,
    options: RequestOptions = {},
  ): Promise<OrderStatusSnapshot> {
    const { marketplace, sellerId } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const spec: RequestSpec = {
      method: "GET",
      path: `${this.#http.adapter.prefix}ordermgmt/orderstatus/orders/${encodeURIComponent(
        String(orderNumber),
      )}`,
      query: { version: ORDER_STATUS_VERSION },
    };
    const result = await this.#http.request(spec, {
      operation: Operation.OrderStatus,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.OrderStatus),
    });
    const parsed = parseOrderStatus(result.json);
    return {
      marketplace,
      orderNumber: parsed.orderNumber || String(orderNumber),
      status: parsed.status,
      statusName: parsed.statusName,
      downloaded: parsed.downloaded,
      salesChannel: parsed.salesChannel,
      fulfillment: parsed.fulfillment,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async tryGetStatus(
    orderNumber: string | number,
    options: RequestOptions = {},
  ): Promise<OrderStatusSnapshot | undefined> {
    try {
      return await this.getStatus(orderNumber, options);
    } catch (err) {
      if (
        err instanceof NeweggApiError &&
        err.neweggErrorCode !== undefined &&
        ORDER_NOT_FOUND_ERROR_CODES.has(err.neweggErrorCode)
      ) {
        return undefined;
      }
      throw err;
    }
  }

  async ship(input: ShipOrderInput, options: RequestOptions = {}): Promise<ShipOrderResult> {
    const { marketplace, sellerId } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const { body, orderNumber } = buildShipRequest(input, sellerId);
    const spec: RequestSpec = {
      method: "PUT",
      path: `${this.#http.adapter.prefix}ordermgmt/orderstatus/orders/${encodeURIComponent(
        orderNumber,
      )}`,
      query: { version: ORDER_WRITE_VERSION },
      body,
    };
    const ctx: RequestContext = {
      operation: Operation.OrderShip,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.OrderShip),
    };
    const result = await this.#sendWrite(spec, ctx, {
      operation: Operation.OrderShip,
      orderNumber,
    });
    const parsed = parseShipResponse(result.json);
    return {
      marketplace,
      orderNumber: parsed.orderNumber || orderNumber,
      status: parsed.status,
      statusLabel: parsed.statusLabel,
      totalPackageCount: parsed.totalPackageCount,
      successCount: parsed.successCount,
      failCount: parsed.failCount,
      packages: parsed.packages,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async cancel(input: CancelOrderInput, options: RequestOptions = {}): Promise<CancelOrderResult> {
    const { marketplace, sellerId } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const { body, orderNumber } = buildCancelRequest(input);
    const spec: RequestSpec = {
      method: "PUT",
      path: `${this.#http.adapter.prefix}ordermgmt/orderstatus/orders/${encodeURIComponent(
        orderNumber,
      )}`,
      query: { version: ORDER_WRITE_VERSION },
      body,
    };
    const ctx: RequestContext = {
      operation: Operation.OrderCancel,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.OrderCancel),
    };
    const result = await this.#sendWrite(spec, ctx, {
      operation: Operation.OrderCancel,
      orderNumber,
    });
    const parsed = parseCancelResponse(result.json);
    return {
      marketplace,
      orderNumber: parsed.orderNumber || orderNumber,
      outcome: parsed.outcome,
      outcomeLabel: parsed.outcomeLabel,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async confirmDownload(
    input: ConfirmOrdersInput,
    options: RequestOptions = {},
  ): Promise<ConfirmOrdersResult> {
    const { marketplace, sellerId } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const { body } = buildConfirmRequest(input);
    const spec: RequestSpec = {
      method: "POST",
      path: `${this.#http.adapter.prefix}ordermgmt/orderstatus/orders/confirmation`,
      body,
    };
    const ctx: RequestContext = {
      operation: Operation.OrderConfirm,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.OrderConfirm),
    };
    const result = await this.#sendWrite(spec, ctx, { operation: Operation.OrderConfirm });
    const parsed = parseConfirmResponse(result.json);
    return {
      marketplace,
      orderNumbers: parsed.orderNumbers,
      requestDate: parsed.requestDate,
      responseDate: parsed.responseDate,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async removeItems(
    input: RemoveOrderItemsInput,
    options: RequestOptions = {},
  ): Promise<RemoveOrderItemsResult> {
    const { marketplace, sellerId } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const { body, orderNumber } = buildRemoveItemsRequest(input);
    const spec: RequestSpec = {
      method: "PUT",
      path: `${this.#http.adapter.prefix}ordermgmt/killitem/orders/${encodeURIComponent(
        orderNumber,
      )}`,
      body,
    };
    const ctx: RequestContext = {
      operation: Operation.OrderRemoveItem,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.OrderRemoveItem),
    };
    const result = await this.#sendWrite(spec, ctx, {
      operation: Operation.OrderRemoveItem,
      orderNumber,
    });
    const parsed = parseRemoveItemsResponse(result.json);
    return {
      marketplace,
      orderNumber: parsed.orderNumber || orderNumber,
      removedSellerPartNumbers: parsed.removedSellerPartNumbers,
      memo: parsed.memo,
      requestDate: parsed.requestDate,
      responseDate: parsed.responseDate,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  /**
   * Sends a single NON-idempotent order-write request. Retries ONLY provably-unsent transport
   * failures (pre-send); an ambiguous failure (timeout/reset after dispatch, or a 408/5xx) throws
   * {@link IndeterminateOrderWriteError} rather than risk a double mutation (ADR 0004). A
   * definitively-unsent transport error surfaces as a non-retryable {@link NeweggApiError};
   * upstream 4xx SO/CE errors pass through unchanged.
   */
  async #sendWrite(
    spec: RequestSpec,
    ctx: RequestContext,
    meta: { operation: string; orderNumber?: string },
  ): Promise<HttpResult> {
    const { retry, marketplace } = this.#config;
    const submittedAtIso = new Date().toISOString();
    await this.#http.acquireRateLimit(ctx);
    let attempt = 0;
    for (;;) {
      try {
        return await this.#http.executeOnce(spec, ctx);
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
            ORDER_WRITE_AMBIGUOUS_STATUSES.has(err.httpStatus));
        if (ambiguous) {
          throw new IndeterminateOrderWriteError(
            "The order write may have reached Newegg but the outcome is unknown.",
            {
              marketplace,
              operation: meta.operation,
              orderNumber: meta.orderNumber,
              submittedAtIso,
              correlationId: ctx.correlationId,
              cause: err,
            },
          );
        }
        if (err instanceof TransportError) {
          throw new NeweggApiError("Order write failed before dispatch and was not sent.", {
            correlationId: ctx.correlationId,
            retryable: false,
            cause: err.cause,
          });
        }
        throw err;
      }
    }
  }
}
