import { randomUUID } from "node:crypto";
import type { NeweggServiceDomain, RequestOptions, ServiceApi, ServiceStatus } from "../types.js";
import type { RequestSpec } from "../platform/index.js";
import type { NeweggHttpClient } from "../client/http.js";
import { Operation } from "../client/operations.js";
import { toTimestamp } from "../platform/dates.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { asBoolean, asString, getField } from "../schemas/wire.js";

/** Service-status API. Tolerates the optional `NeweggAPIResponse` wrapper and string booleans. */
export class ServiceApiImpl implements ServiceApi {
  readonly #http: NeweggHttpClient;

  constructor(http: NeweggHttpClient) {
    this.#http = http;
  }

  async getStatus(
    domain: NeweggServiceDomain = "contentmgmt",
    options: RequestOptions = {},
  ): Promise<ServiceStatus> {
    const { marketplace, sellerId } = this.#http.config;
    const correlationId = options.correlationId ?? randomUUID();
    const spec: RequestSpec = {
      method: "GET",
      path: `${this.#http.adapter.prefix}${domain}/servicestatus`,
    };
    const result = await this.#http.request(spec, {
      operation: Operation.ServiceStatus,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.ServiceStatus),
    });

    const root = getField(result.json, "NeweggAPIResponse") ?? result.json;
    const body = getField(root, "ResponseBody") ?? root;
    const available = asBoolean(getField(body, "Status")) ?? false;

    return {
      marketplace,
      domain,
      available,
      timestamp: toTimestamp(asString(getField(body, "Timestamp"))),
      message: asString(getField(body, "Message")),
      correlationId,
      raw: options.includeRaw ? result.json : undefined,
    };
  }
}
