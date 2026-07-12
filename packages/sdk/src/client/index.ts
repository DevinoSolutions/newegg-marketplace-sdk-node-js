import type { NeweggClient, NeweggClientConfig } from "../types.js";
import { getAdapter } from "../platform/index.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { FEED_RECORDS_PER_HOUR, FEED_SUBMISSIONS_PER_MINUTE } from "../feeds/constants.js";
import { FeedsApiImpl } from "../feeds/api.js";
import { InventoryApiImpl } from "../inventory/api.js";
import { OrdersApiImpl } from "../orders/api.js";
import { ServiceApiImpl } from "../service/api.js";
import { resolveConfig } from "./config.js";
import { NeweggHttpClient } from "./http.js";
import { Operation } from "./operations.js";

/**
 * Creates a Newegg Marketplace client. Validates configuration eagerly (throws
 * {@link NeweggConfigurationError} on invalid input) and performs no network access or
 * credential use at construction time. Call {@link NeweggClient.verifyCredentials} once at
 * startup for a read-only, fail-fast check that the credentials are actually accepted.
 */
export function createNeweggClient(config: NeweggClientConfig): NeweggClient {
  const resolved = resolveConfig(config);
  const adapter = getAdapter(resolved.marketplace);
  const http = new NeweggHttpClient(resolved, adapter);

  // Local feed-submission budget: 10 submissions/min + 100,000 records/hour per seller.
  resolved.rateLimitStore.configure(
    rateLimitKey(resolved.marketplace, resolved.sellerId, Operation.FeedSubmit),
    { maxPerMinute: FEED_SUBMISSIONS_PER_MINUTE, maxRecordsPerHour: FEED_RECORDS_PER_HOUR },
  );

  const feeds = new FeedsApiImpl(http);
  const inventory = new InventoryApiImpl(http, feeds);
  const service = new ServiceApiImpl(http);
  const orders = new OrdersApiImpl(http);

  return {
    marketplace: resolved.marketplace,
    inventory,
    feeds,
    service,
    orders,
    async verifyCredentials(options) {
      // Read-only preflight: a single service-status GET. Bad/unauthorized credentials throw
      // here (NeweggAuthenticationError on 401, NeweggAuthorizationError on 403) so callers
      // fail fast at startup instead of scattering credential checks through their code.
      const status = await service.getStatus("contentmgmt", options);
      return {
        ok: true,
        marketplace: resolved.marketplace,
        domain: status.domain,
        serviceAvailable: status.available,
        timestamp: status.timestamp,
        correlationId: status.correlationId,
      };
    },
  };
}
