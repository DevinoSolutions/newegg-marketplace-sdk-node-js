import type {
  NeweggClientConfig,
  NeweggLogger,
  NeweggMarketplace,
  OperationStore,
  RateLimitStore,
  ReportFileDownloader,
  ReportFileFtpOptions,
  RetryOptions,
} from "../types.js";
import { NeweggConfigurationError, NeweggMarketplaceMismatchError } from "../errors/index.js";
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
  reportFileDownloader?: ReportFileDownloader;
  reportFileFtp?: ReportFileFtpOptions;
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

function resolveReportFileFtp(
  options: ReportFileFtpOptions | undefined,
): ReportFileFtpOptions | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null) {
    fail('Configuration field "reportFileFtp" must be an object.');
  }
  if (options.ftps !== undefined && typeof options.ftps !== "boolean") {
    fail('Configuration field "reportFileFtp.ftps" must be a boolean.');
  }
  if (
    options.tlsPinnedCertSha256 !== undefined &&
    !/^[0-9a-f]{2}(:?[0-9a-f]{2}){31}$/i.test(options.tlsPinnedCertSha256)
  ) {
    fail(
      'Configuration field "reportFileFtp.tlsPinnedCertSha256" must be a SHA-256 hex fingerprint.',
    );
  }
  if (
    (options.tlsPinnedCertSha256 !== undefined || options.tlsCa !== undefined) &&
    options.ftps !== true
  ) {
    fail(
      'Configuration field "reportFileFtp.tlsPinnedCertSha256" / "reportFileFtp.tlsCa" only apply with "reportFileFtp.ftps: true"; without it the report download would silently stay plain FTP.',
    );
  }
  if (options.tlsPinnedCertSha256 !== undefined && options.tlsCa === undefined) {
    fail(
      'Configuration field "reportFileFtp.tlsPinnedCertSha256" needs "reportFileFtp.tlsCa" (the pinned certificate PEM): certificate validation is never disabled, so a self-signed certificate must be trusted explicitly.',
    );
  }
  if (options.allowedPorts !== undefined) {
    const ports: unknown = options.allowedPorts;
    if (
      !Array.isArray(ports) ||
      ports.length === 0 ||
      !ports.every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
    ) {
      fail('Configuration field "reportFileFtp.allowedPorts" must be a non-empty list of ports.');
    }
  }
  return { ...options };
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/** The default allowlist: `newegg.com` and its subdomains (checked on the parsed hostname). */
function isNeweggHost(hostname: string): boolean {
  return hostname === "newegg.com" || hostname.endsWith(".newegg.com");
}

function resolveBaseUrl(raw: string | undefined, allowCustom: boolean, logger: NeweggLogger): URL {
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
  // Credentials ride on every request, so a non-Newegg host is refused unless explicitly allowed.
  // Judged on the parsed hostname: `https://newegg.com@evil.example/` has hostname evil.example.
  if (httpsOk && !isNeweggHost(url.hostname)) {
    if (!allowCustom) {
      fail(
        'Configuration field "baseUrl" must be a newegg.com host (API keys are sent to it); set "allowCustomBaseUrl: true" to use another https host.',
      );
    }
    // Host only: the path and query of a custom endpoint may be sensitive.
    logger.warn("config.custom_base_url", { host: url.hostname });
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

  if (config.credentialMarketplace !== undefined) {
    if (!MARKETPLACES.includes(config.credentialMarketplace)) {
      fail('Configuration field "credentialMarketplace" must be one of "us", "b2b", "ca".');
    }
    if (config.credentialMarketplace !== config.marketplace) {
      // Names only: never echo credential values. Newegg authenticates on the key pair alone, so
      // this combination would silently read/write the key owner's account (contracts §2).
      throw new NeweggMarketplaceMismatchError(
        `The credentials were issued for the "${config.credentialMarketplace}" marketplace but the ` +
          `client targets "${config.marketplace}". Newegg authenticates on the key pair alone and ` +
          `would serve the key owner's own account, so this combination is refused.`,
        {
          expectedMarketplace: config.marketplace,
          actualMarketplace: config.credentialMarketplace,
        },
      );
    }
  }

  if (config.allowCustomBaseUrl !== undefined && typeof config.allowCustomBaseUrl !== "boolean") {
    fail('Configuration field "allowCustomBaseUrl" must be a boolean.');
  }
  const baseUrl = resolveBaseUrl(
    config.baseUrl,
    config.allowCustomBaseUrl === true,
    config.logger ?? noopLogger,
  );

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
    reportFileDownloader: config.reportFileDownloader,
    reportFileFtp: resolveReportFileFtp(config.reportFileFtp),
  };
}
