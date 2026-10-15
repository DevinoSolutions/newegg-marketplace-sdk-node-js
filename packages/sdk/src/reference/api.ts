import { randomUUID } from "node:crypto";
import type {
  IndustriesResult,
  ListIndustriesInput,
  ListPropertyValuesInput,
  ListSubcategoriesInput,
  PropertyValuesResult,
  ReferenceApi,
  RequestOptions,
  SellerStatus,
  SubcategoriesResult,
  SubcategoryPropertiesResult,
} from "../types.js";
import type { RequestSpec } from "../platform/index.js";
import type { HttpResult, NeweggHttpClient } from "../client/http.js";
import { Operation } from "../client/operations.js";
import { getReferencePlatform, subcategoryStatusPath } from "../platform/reference.js";
import { rateLimitKey } from "../rate-limit/index.js";
import {
  INDUSTRY_PATH,
  PROPERTY_VALUE_PATH,
  SELLER_STATUS_PATH,
  SUBCATEGORY_PROPERTY_PATH,
} from "./constants.js";
import {
  buildIndustryQuery,
  buildPropertyValueBody,
  buildSubcategoryPropertyBody,
  buildSubcategoryStatusBody,
  parseIndustries,
  parsePropertyValues,
  parseSellerStatus,
  parseSubcategories,
  parseSubcategoryProperties,
  validateSubcategoryId,
} from "./parse.js";

/**
 * Seller / category reference reads (contracts §19): Seller Status Check, Get Industry List, Get
 * Subcategory Status (plus its Newegg.com-only international variant), Get Subcategory Properties
 * and Get Subcategory Property Values. Every operation is a READ - several are `PUT` with a
 * request body, which does not make them writes. Get Warehouse List and Get Subcategory Status
 * v1.1 are deliberately not implemented (§19.1).
 */
export class ReferenceApiImpl implements ReferenceApi {
  readonly #http: NeweggHttpClient;

  constructor(http: NeweggHttpClient) {
    this.#http = http;
  }

  async getSellerStatus(options: RequestOptions = {}): Promise<SellerStatus> {
    const { marketplace } = this.#http.config;
    const platform = getReferencePlatform(marketplace);
    const correlationId = options.correlationId ?? randomUUID();
    const result = await this.#send(
      Operation.SellerStatus,
      {
        method: "GET",
        path: `${this.#http.adapter.prefix}${SELLER_STATUS_PATH}`,
        query: platform.sellerStatusQuery,
      },
      correlationId,
      options,
    );
    return {
      marketplace,
      ...parseSellerStatus(result.json, correlationId),
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async listIndustries(
    input: ListIndustriesInput = {},
    options: RequestOptions = {},
  ): Promise<IndustriesResult> {
    const { marketplace } = this.#http.config;
    const query = buildIndustryQuery(input);
    const correlationId = options.correlationId ?? randomUUID();
    const result = await this.#send(
      Operation.IndustryList,
      { method: "GET", path: `${this.#http.adapter.prefix}${INDUSTRY_PATH}`, query },
      correlationId,
      options,
    );
    return {
      marketplace,
      industries: parseIndustries(result.json, correlationId),
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async listSubcategories(
    input: ListSubcategoriesInput = {},
    options: RequestOptions = {},
  ): Promise<SubcategoriesResult> {
    const { marketplace } = this.#http.config;
    const path = subcategoryStatusPath(getReferencePlatform(marketplace), input.countryCode);
    const body = buildSubcategoryStatusBody(input);
    const correlationId = options.correlationId ?? randomUUID();
    const result = await this.#send(
      Operation.SubcategoryStatus,
      { method: "PUT", path: `${this.#http.adapter.prefix}${path}`, body },
      correlationId,
      options,
    );
    const parsed = parseSubcategories(result.json, correlationId);
    return {
      marketplace,
      countryCode: parsed.countryCode ?? input.countryCode,
      subcategories: parsed.subcategories,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async listSubcategoryProperties(
    subcategoryId: number,
    options: RequestOptions = {},
  ): Promise<SubcategoryPropertiesResult> {
    const { marketplace } = this.#http.config;
    const id = validateSubcategoryId(subcategoryId);
    const correlationId = options.correlationId ?? randomUUID();
    const result = await this.#send(
      Operation.SubcategoryProperties,
      {
        method: "PUT",
        path: `${this.#http.adapter.prefix}${SUBCATEGORY_PROPERTY_PATH}`,
        body: buildSubcategoryPropertyBody(id),
      },
      correlationId,
      options,
    );
    return {
      marketplace,
      subcategoryId: id,
      properties: parseSubcategoryProperties(result.json, correlationId),
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async listPropertyValues(
    input: ListPropertyValuesInput,
    options: RequestOptions = {},
  ): Promise<PropertyValuesResult> {
    const { marketplace } = this.#http.config;
    const body = buildPropertyValueBody(input);
    const correlationId = options.correlationId ?? randomUUID();
    const result = await this.#send(
      Operation.PropertyValues,
      { method: "PUT", path: `${this.#http.adapter.prefix}${PROPERTY_VALUE_PATH}`, body },
      correlationId,
      options,
    );
    return {
      marketplace,
      properties: parsePropertyValues(result.json, correlationId),
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
