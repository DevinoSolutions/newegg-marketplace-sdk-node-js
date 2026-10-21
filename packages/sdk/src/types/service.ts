/** Service status types. Re-exported from `../types.ts`. */

import type { NeweggMarketplace, NeweggServiceDomain, RequestOptions } from "./common.js";

// ----------------------------------------------------------------------------
// service
// ----------------------------------------------------------------------------
export interface ServiceStatus {
  marketplace: NeweggMarketplace;
  domain: NeweggServiceDomain;
  available: boolean;
  timestamp?: { raw: string; iso?: string };
  message?: string;
  correlationId: string;
  raw?: unknown;
}
export interface ServiceApi {
  /** Defaults to the "contentmgmt" domain. */
  getStatus(domain?: NeweggServiceDomain, options?: RequestOptions): Promise<ServiceStatus>;
}
