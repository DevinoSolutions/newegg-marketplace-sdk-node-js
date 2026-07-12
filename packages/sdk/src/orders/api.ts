import { randomUUID } from "node:crypto";
import type {
  ListOrdersInput,
  Order,
  OrdersApi,
  OrdersPage,
  OrderStatusSnapshot,
  RequestOptions,
} from "../types.js";
import type { RequestSpec } from "../platform/index.js";
import type { NeweggHttpClient } from "../client/http.js";
import { NeweggApiError } from "../errors/index.js";
import { Operation } from "../client/operations.js";
import { rateLimitKey } from "../rate-limit/index.js";
import {
  ORDER_INFO_VERSION,
  ORDER_NOT_FOUND_ERROR_CODES,
  ORDER_STATUS_VERSION,
} from "./constants.js";
import { buildOrderInfoRequest, parseOrderStatus, parseOrdersResponse } from "./parse.js";

/**
 * Read-only Orders API: order search (`list`), single-order detail (`get`/`tryGet`), and a
 * lightweight status check (`getStatus`/`tryGetStatus`). `list` and `get` share Newegg's Get
 * Order Information endpoint (1000 req/hr); `getStatus` uses Get Order Status (500 req/hr).
 * Never mutates anything.
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
}
