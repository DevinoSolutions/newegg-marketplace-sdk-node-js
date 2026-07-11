import type {
  NeweggClientConfig,
  NeweggLogger,
  NeweggMarketplace,
  OperationStore,
  RateLimitStore,
  RetryOptions,
} from "../types.js";
import { NeweggConfigurationError } from "../errors/index.js";
import { noopLogger } from "../logging/index.js";
import { InMemoryRateLimitStore } from "../rate-limit/index.js";
import { InMemoryOperationStore } from "../operation-store/index.js";
import { DEFAULT_AUTO_FEED_THRESHOLD } from "../inventory/constants.js";
import { defaultUserAgent } from "../version.js";

const DEFAULT_BASE_URL = "https://api.newegg.com/marketplace/";
const DEFAULT_TIMEOUT_MS = 30_000;
const MARKETPLACES: readonly NeweggMarketplace[] = ["us", "b2b", "ca"];

/** Fully-resolved, validated configuration used internally by the client. */
export interface ResolvedConfig {
  sellerId: string;
  apiKey: string;
  secretKey: string;
  marketplace: NeweggMarketplace;
  baseUrl: URL;
  timeoutMs: number;
  userAgent: string;
  retry: Required<RetryOptions>;
  logger: NeweggLogger;
  fetch: typeof globalThis.fetch;
  rateLimitStore: RateLimitStore;
  operationStore: OperationStore;
  autoFeedThreshold: number;
  maxQuantity?: number;
}

function fail(message: string): never {
  throw new NeweggConfigurationError(message);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`Configuration field "${field}" must be a non-empty string.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`Configuration field "${field}" must be a positive integer.`);
  }
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function resolveBaseUrl(raw: string | undefined): URL {
  const value = raw ?? DEFAULT_BASE_URL;
  if (!value.endsWith("/")) {
    fail('Configuration field "baseUrl" must end with "/".');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('Configuration field "baseUrl" must be a valid absolute URL.');
  }
  const httpsOk = url.protocol === "https:";
  const httpLoopbackOk = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (!httpsOk && !httpLoopbackOk) {
    fail(
      'Configuration field "baseUrl" must use https (http is allowed only for localhost/127.0.0.1).',
    );
  }
  return url;
}

function resolveRetry(retry: RetryOptions | undefined): Required<RetryOptions> {
  const maxAttempts = retry?.maxAttempts ?? 3;
  const baseDelayMs = retry?.baseDelayMs ?? 250;
  const maxDelayMs = retry?.maxDelayMs ?? 10_000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    fail('Configuration field "retry.maxAttempts" must be an integer >= 1.');
  }
  if (typeof baseDelayMs !== "number" || baseDelayMs < 0) {
    fail('Configuration field "retry.baseDelayMs" must be a non-negative number.');
  }
  if (typeof maxDelayMs !== "number" || maxDelayMs < 0) {
    fail('Configuration field "retry.maxDelayMs" must be a non-negative number.');
  }
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

/**
 * Validates and resolves client configuration. Throws {@link NeweggConfigurationError} on any
 * invalid field. No network access or credential use occurs here.
 */
export function resolveConfig(config: NeweggClientConfig): ResolvedConfig {
  if (config === null || typeof config !== "object") {
    fail("Configuration object is required.");
  }
  const sellerId = requireNonEmptyString(config.sellerId, "sellerId");
  const apiKey = requireNonEmptyString(config.apiKey, "apiKey");
  const secretKey = requireNonEmptyString(config.secretKey, "secretKey");

  if (!MARKETPLACES.includes(config.marketplace)) {
    fail('Configuration field "marketplace" must be one of "us", "b2b", "ca".');
  }

  const baseUrl = resolveBaseUrl(config.baseUrl);

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    fail('Configuration field "timeoutMs" must be a positive number.');
  }

  const fetchImpl: typeof globalThis.fetch = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    fail("No fetch implementation available; provide config.fetch or run on Node >= 22.");
  }

  const autoFeedThreshold =
    config.strategy?.autoFeedThreshold === undefined
      ? DEFAULT_AUTO_FEED_THRESHOLD
      : requirePositiveInteger(config.strategy.autoFeedThreshold, "strategy.autoFeedThreshold");

  let maxQuantity: number | undefined;
  if (config.maxQuantity !== undefined) {
    maxQuantity = requirePositiveInteger(config.maxQuantity, "maxQuantity");
  }

  return {
    sellerId,
    apiKey,
    secretKey,
    marketplace: config.marketplace,
    baseUrl,
    timeoutMs,
    userAgent: config.userAgent ?? defaultUserAgent(),
    retry: resolveRetry(config.retry),
    logger: config.logger ?? noopLogger,
    fetch: fetchImpl,
    rateLimitStore: config.rateLimitStore ?? new InMemoryRateLimitStore(),
    operationStore: config.operationStore ?? new InMemoryOperationStore(),
    autoFeedThreshold,
    maxQuantity,
  };
}
