/**
 * Environment-driven configuration for the MCP server. `loadMcpConfigFromEnv` parses and
 * validates process env into a typed `McpServerConfig`, separating credentials (redacted on
 * serialization) from limits and HTTP settings so accidental logging of the config object can
 * never leak secrets. This module never imports the MCP SDK (ADR 0001).
 */
import { z } from "zod";
import type { NeweggMarketplace } from "@devino/newegg-marketplace-sdk";

/** Thrown for any invalid/missing configuration. Messages name the offending variable and
 * never echo provided secret values. */
export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

/** Credentials holder. Field access yields raw values (needed to build the SDK client), but
 * `toJSON` redacts every field so `JSON.stringify(config)` cannot leak secrets. */
export interface McpCredentials {
  readonly sellerId: string;
  readonly apiKey: string;
  readonly secretKey: string;
  toJSON(): Record<string, string>;
}

export interface McpLimits {
  readonly maxItemsPerOperation: number;
  readonly previewTtlSeconds: number;
  readonly allowZeroQuantity: boolean;
  /** Uppercased warehouse codes; empty means "all warehouses allowed". */
  readonly allowedWarehouses: string[];
  /** Normalized marketplace codes; empty means "all marketplaces allowed". */
  readonly allowedMarketplaces: NeweggMarketplace[];
}

export interface McpHttpConfig {
  readonly host: string;
  readonly port: number;
  readonly bearerToken?: string;
  readonly allowedOrigins: string[];
  readonly allowedHosts: string[];
}

export interface McpServerConfig {
  readonly marketplace: NeweggMarketplace;
  /** Trusted-config-only base URL override; never exposed through MCP tools/resources. */
  readonly baseUrl?: string;
  readonly allowWrites: boolean;
  readonly credentials: McpCredentials;
  readonly limits: McpLimits;
  readonly http: McpHttpConfig;
}

/** Loose record of the environment. Defaults to `process.env`. */
export type EnvRecord = Record<string, string | undefined>;

const MARKETPLACES = ["us", "b2b", "ca"] as const;

const REDACTED = "***redacted***";

function makeCredentials(sellerId: string, apiKey: string, secretKey: string): McpCredentials {
  return {
    sellerId,
    apiKey,
    secretKey,
    toJSON(): Record<string, string> {
      return { sellerId: REDACTED, apiKey: REDACTED, secretKey: REDACTED };
    },
  };
}

function requiredString(env: EnvRecord, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new McpConfigError(
      `${name} is required but was not set (configure it in the environment or .env).`,
    );
  }
  return value.trim();
}

function normalizeMarketplace(raw: string, source: string): NeweggMarketplace {
  const lowered = raw.trim().toLowerCase();
  const canonical = lowered === "can" ? "ca" : lowered;
  const found = MARKETPLACES.find((m) => m === canonical);
  if (found === undefined) {
    throw new McpConfigError(
      `${source} must be one of: us, b2b, ca (the alias "can" is accepted for ca).`,
    );
  }
  return found;
}

const positiveIntSchema = z.number().int().positive();
const portSchema = z.number().int().min(1).max(65535);

function optionalInt(
  env: EnvRecord,
  name: string,
  fallback: number,
  schema: z.ZodType<number>,
): number {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value.trim());
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new McpConfigError(`${name} must be a valid integer (received an invalid value).`);
  }
  return result.data;
}

function optionalBool(env: EnvRecord, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const lowered = value.trim().toLowerCase();
  if (lowered === "true") {
    return true;
  }
  if (lowered === "false") {
    return false;
  }
  throw new McpConfigError(`${name} must be "true" or "false".`);
}

function csv(env: EnvRecord, name: string): string[] {
  const value = env[name];
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function optionalUrl(env: EnvRecord, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  try {
    // Validate; the SDK re-validates and only trusts this from config, never from MCP callers.
    void new URL(trimmed);
  } catch {
    throw new McpConfigError(`${name} must be a valid absolute URL.`);
  }
  return trimmed;
}

/**
 * Parses and validates configuration from an environment record (defaults to `process.env`).
 * Throws `McpConfigError` with an actionable, secret-free message on any problem.
 */
export function loadMcpConfigFromEnv(env: EnvRecord = process.env): McpServerConfig {
  const credentials = makeCredentials(
    requiredString(env, "NEWEGG_SELLER_ID"),
    requiredString(env, "NEWEGG_API_KEY"),
    requiredString(env, "NEWEGG_SECRET_KEY"),
  );

  const marketplace = normalizeMarketplace(
    requiredString(env, "NEWEGG_MARKETPLACE"),
    "NEWEGG_MARKETPLACE",
  );
  const baseUrl = optionalUrl(env, "NEWEGG_API_BASE_URL");
  const allowWrites = env.NEWEGG_MCP_ALLOW_WRITES === "true";

  const allowedMarketplaces = csv(env, "NEWEGG_MCP_ALLOWED_MARKETPLACES").map((entry) =>
    normalizeMarketplace(entry, "NEWEGG_MCP_ALLOWED_MARKETPLACES"),
  );
  if (allowedMarketplaces.length > 0 && !allowedMarketplaces.includes(marketplace)) {
    throw new McpConfigError(
      `Configured NEWEGG_MARKETPLACE (${marketplace}) is not present in NEWEGG_MCP_ALLOWED_MARKETPLACES; refusing to start.`,
    );
  }

  const limits: McpLimits = {
    maxItemsPerOperation: optionalInt(
      env,
      "NEWEGG_MCP_MAX_ITEMS_PER_OPERATION",
      500,
      positiveIntSchema,
    ),
    previewTtlSeconds: optionalInt(env, "NEWEGG_MCP_PREVIEW_TTL_SECONDS", 600, positiveIntSchema),
    allowZeroQuantity: optionalBool(env, "NEWEGG_MCP_ALLOW_ZERO_QUANTITY", true),
    allowedWarehouses: csv(env, "NEWEGG_MCP_ALLOWED_WAREHOUSES").map((entry) =>
      entry.toUpperCase(),
    ),
    allowedMarketplaces,
  };

  const bearerTokenRaw = env.NEWEGG_MCP_HTTP_BEARER_TOKEN;
  const http: McpHttpConfig = {
    host: (env.NEWEGG_MCP_HTTP_HOST ?? "127.0.0.1").trim() || "127.0.0.1",
    port: optionalInt(env, "NEWEGG_MCP_HTTP_PORT", 3919, portSchema),
    bearerToken:
      bearerTokenRaw !== undefined && bearerTokenRaw.trim() !== ""
        ? bearerTokenRaw.trim()
        : undefined,
    allowedOrigins: csv(env, "NEWEGG_MCP_HTTP_ALLOWED_ORIGINS"),
    allowedHosts: csv(env, "NEWEGG_MCP_HTTP_ALLOWED_HOSTS"),
  };

  return { marketplace, baseUrl, allowWrites, credentials, limits, http };
}
