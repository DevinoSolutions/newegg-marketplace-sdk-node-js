import { randomUUID } from "node:crypto";
import type {
  GetSbnRequestStatusInput,
  ListSbnShipmentsInput,
  ListSbnWarehousesInput,
  RequestOptions,
  SbnApi,
  SbnRequestResult,
  SbnRequestStatusResult,
  SbnShipmentsResult,
  SbnWarehousesResult,
} from "../types.js";
import type { RequestSpec } from "../platform/index.js";
import type { HttpResult, NeweggHttpClient } from "../client/http.js";
import { Operation } from "../client/operations.js";
import { assertSbnSupported, getSbnPlatform } from "../platform/sbn.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { sanitizeRaw } from "../reportmgmt/redact.js";
import {
  SBN_SHIPMENT_LIST_PATH,
  SBN_SHIPMENT_RESULT_PATH,
  SBN_SHIPMENT_STATUS_PATH,
  SBN_WAREHOUSE_PATH,
} from "./constants.js";
import {
  buildShipmentListRequest,
  buildShipmentStatusBody,
  buildWarehouseBody,
  parseShipmentList,
  parseShipmentResult,
  parseShipmentStatus,
  parseWarehouseList,
  validateSbnRequestId,
} from "./parse.js";

/**
 * Shipped-by-Newegg inbound-shipment reads (contracts §21): Get Inbound Shipment List, Get Inbound
 * Shipment Status Request, Get Inbound Shipment Request Result and Get Warehouse List. Every
 * operation is a READ - three are `PUT` with a request body, which does not make them writes.
 * Create / Void Inbound Shipment and Get Inbound Shipment Plan Suggestion are deliberately not
 * implemented (§21.1). Newegg.com and Newegg Business only; CAN fails before sending (ADR 0002).
 */
export class SbnApiImpl implements SbnApi {
  readonly #http: NeweggHttpClient;

  constructor(http: NeweggHttpClient) {
    this.#http = http;
  }

  async listShipments(
    input: ListSbnShipmentsInput = {},
    options: RequestOptions = {},
  ): Promise<SbnShipmentsResult> {
    const { marketplace } = this.#http.config;
    assertSbnSupported(getSbnPlatform(marketplace));
    const request = buildShipmentListRequest(input);
    const correlationId = options.correlationId ?? randomUUID();
    const result = await this.#send(
      Operation.SbnShipmentList,
      {
        method: "PUT",
        path: `${this.#http.adapter.prefix}${SBN_SHIPMENT_LIST_PATH}`,
        body: request.body,
      },
      correlationId,
      options,
    );
    return {
      marketplace,
      page: request.page,
      pageSize: request.pageSize,
      shipments: parseShipmentList(result.json, correlationId),
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async getRequestStatus(
    input: GetSbnRequestStatusInput = {},
    options: RequestOptions = {},
  ): Promise<SbnRequestStatusResult> {
    const { marketplace } = this.#http.config;
    assertSbnSupported(getSbnPlatform(marketplace));
    const body = buildShipmentStatusBody(input);
    const correlationId = options.correlationId ?? randomUUID();
    const result = await this.#send(
      Operation.SbnRequestStatus,
      { method: "PUT", path: `${this.#http.adapter.prefix}${SBN_SHIPMENT_STATUS_PATH}`, body },
      correlationId,
      options,
    );
    return {
      marketplace,
      requests: parseShipmentStatus(result.json, correlationId),
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async getRequestResult(
    requestId: string,
    options: RequestOptions = {},
  ): Promise<SbnRequestResult> {
    const { marketplace } = this.#http.config;
    assertSbnSupported(getSbnPlatform(marketplace));
    const id = validateSbnRequestId(requestId);
    const correlationId = options.correlationId ?? randomUUID();
    const result = await this.#send(
      Operation.SbnRequestResult,
      {
        method: "GET",
        path: `${this.#http.adapter.prefix}${SBN_SHIPMENT_RESULT_PATH}/${encodeURIComponent(id)}`,
      },
      correlationId,
      options,
    );
    const parsed = parseShipmentResult(result.json, correlationId);
    return {
      marketplace,
      requestId: parsed.requestId ?? id,
      requestedAt: parsed.requestedAt,
      processedAt: parsed.processedAt,
      status: parsed.status,
      shipmentId: parsed.shipmentId,
      labels: parsed.labels,
      errors: parsed.errors,
      correlationId,
      rateLimit: result.rateLimit,
      // Label URLs may embed credentials: never surface the payload unredacted.
      raw: options.includeRaw ? sanitizeRaw(result.json) : undefined,
    };
  }

  async listWarehouses(
    input: ListSbnWarehousesInput = {},
    options: RequestOptions = {},
  ): Promise<SbnWarehousesResult> {
    const { marketplace } = this.#http.config;
    assertSbnSupported(getSbnPlatform(marketplace));
    const body = buildWarehouseBody(input);
    const correlationId = options.correlationId ?? randomUUID();
    const result = await this.#send(
      Operation.SbnWarehouseList,
      { method: "PUT", path: `${this.#http.adapter.prefix}${SBN_WAREHOUSE_PATH}`, body },
      correlationId,
      options,
    );
    return {
      marketplace,
      warehouses: parseWarehouseList(result.json, correlationId),
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  #send(
    operation: string,
    spec: RequestSpec,
    correlationId: string,
    options: RequestOptions,
  ): Promise<HttpResult> {
    const { marketplace, sellerId } = this.#http.config;
    return this.#http.request(spec, {
      operation,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, operation),
    });
  }
}
