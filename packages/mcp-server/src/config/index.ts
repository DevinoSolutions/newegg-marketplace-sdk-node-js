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

// ---------------------------------------------------------------------------
// Single zod v4 env schema. One `safeParse` pass validates EVERY variable and
// collects ALL problems, so a misconfigured operator sees every missing/invalid
// var at once instead of one-per-restart. Each field's message names its own
// variable (built inside the transforms, never relying on zod's default type
// text) and never echoes a provided value, so secrets cannot leak into errors.
// ---------------------------------------------------------------------------

const required = (name: string): string =>
  `${name} is required but was not set (configure it in the environment or .env).`;

const marketplaceHint = (name: string): string =>
  `${name} must be one of: us, b2b, ca (the alias "can" is accepted for ca).`;

/** Normalizes a marketplace token (trim, lowercase, "can" -> "ca"); undefined if unrecognized. */
function normalizeMarketplace(raw: string): NeweggMarketplace | undefined {
  const canonical = raw.trim().toLowerCase() === "can" ? "ca" : raw.trim().toLowerCase();
  return (MARKETPLACES as readonly string[]).includes(canonical)
    ? (canonical as NeweggMarketplace)
    : undefined;
}

/** Required, trimmed, non-empty string. The var name is guaranteed to appear in the error. */
function requiredEnv(name: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const trimmed = raw?.trim();
      if (trimmed === undefined || trimmed === "") {
        ctx.addIssue({ code: "custom", message: required(name) });
        return z.NEVER;
      }
      return trimmed;
    });
}

/** Required marketplace with distinct "missing" vs "invalid value" messages. */
function marketplaceEnv(name: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const trimmed = raw?.trim();
      if (trimmed === undefined || trimmed === "") {
        ctx.addIssue({ code: "custom", message: required(name) });
        return z.NEVER;
      }
      const normalized = normalizeMarketplace(trimmed);
      if (normalized === undefined) {
        ctx.addIssue({ code: "custom", message: marketplaceHint(name) });
        return z.NEVER;
      }
      return normalized;
    });
}

const isPositiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;
const isPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;

/** Optional integer with a default; the parsed number must satisfy `check`. */
function intEnv(name: string, fallback: number, check: (n: number) => boolean, hint: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const trimmed = raw?.trim();
      if (trimmed === undefined || trimmed === "") return fallback;
      const parsed = Number(trimmed);
      if (!check(parsed)) {
        ctx.addIssue({ code: "custom", message: `${name} must be ${hint}.` });
        return z.NEVER;
      }
      return parsed;
    });
}

/** Optional boolean accepting only "true"/"false" (case-insensitive); default `fallback`. */
function boolEnv(name: string, fallback: boolean) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const lowered = raw?.trim().toLowerCase();
      if (lowered === undefined || lowered === "") return fallback;
      if (lowered === "true") return true;
      if (lowered === "false") return false;
      ctx.addIssue({ code: "custom", message: `${name} must be "true" or "false".` });
      return z.NEVER;
    });
}

/** Splits a CSV env value into trimmed, non-empty entries. */
function splitCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Optional CSV list; blanks dropped, optionally uppercased. */
function csvEnv(opts: { uppercase?: boolean } = {}) {
  return z
    .string()
    .optional()
    .transform((raw) =>
      opts.uppercase ? splitCsv(raw).map((entry) => entry.toUpperCase()) : splitCsv(raw),
    );
}

/** Optional CSV of marketplace tokens; each normalized + validated. */
function marketplaceCsvEnv(name: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const out: NeweggMarketplace[] = [];
      for (const entry of splitCsv(raw)) {
        const normalized = normalizeMarketplace(entry);
        if (normalized === undefined)
          ctx.addIssue({ code: "custom", message: marketplaceHint(name) });
        else out.push(normalized);
      }
      return out;
    });
}

/** Optional absolute URL, validated with the WHATWG URL parser. */
function urlEnv(name: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const trimmed = raw?.trim();
      if (trimmed === undefined || trimmed === "") return undefined;
      try {
        void new URL(trimmed);
      } catch {
        ctx.addIssue({ code: "custom", message: `${name} must be a valid absolute URL.` });
        return z.NEVER;
      }
      return trimmed;
    });
}

/** Optional trimmed string, or undefined when unset/blank (used for the HTTP bearer token). */
function optionalTrimmedEnv() {
  return z
    .string()
    .optional()
    .transform((raw) => {
      const trimmed = raw?.trim();
      return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
    });
}

const envSchema = z.object({
  NEWEGG_SELLER_ID: requiredEnv("NEWEGG_SELLER_ID"),
  NEWEGG_API_KEY: requiredEnv("NEWEGG_API_KEY"),
  NEWEGG_SECRET_KEY: requiredEnv("NEWEGG_SECRET_KEY"),
  NEWEGG_MARKETPLACE: marketplaceEnv("NEWEGG_MARKETPLACE"),
  NEWEGG_API_BASE_URL: urlEnv("NEWEGG_API_BASE_URL"),
  // SECURITY gate: only the EXACT literal "true" enables writes. "1"/"TRUE"/" true "/unset all
  // stay false. Kept as a raw `=== "true"` (no trim/lowercase) so the surface can't widen by accident.
  NEWEGG_MCP_ALLOW_WRITES: z
    .string()
    .optional()
    .transform((raw) => raw === "true"),
  NEWEGG_MCP_ALLOWED_MARKETPLACES: marketplaceCsvEnv("NEWEGG_MCP_ALLOWED_MARKETPLACES"),
  NEWEGG_MCP_MAX_ITEMS_PER_OPERATION: intEnv(
    "NEWEGG_MCP_MAX_ITEMS_PER_OPERATION",
    500,
    isPositiveInt,
    "a positive integer",
  ),
  NEWEGG_MCP_PREVIEW_TTL_SECONDS: intEnv(
    "NEWEGG_MCP_PREVIEW_TTL_SECONDS",
    600,
    isPositiveInt,
    "a positive integer",
  ),
  NEWEGG_MCP_ALLOW_ZERO_QUANTITY: boolEnv("NEWEGG_MCP_ALLOW_ZERO_QUANTITY", true),
  NEWEGG_MCP_ALLOWED_WAREHOUSES: csvEnv({ uppercase: true }),
  NEWEGG_MCP_HTTP_HOST: z
    .string()
    .optional()
    .transform((raw) => {
      const trimmed = (raw ?? "").trim();
      return trimmed.length > 0 ? trimmed : "127.0.0.1";
    }),
  NEWEGG_MCP_HTTP_PORT: intEnv(
    "NEWEGG_MCP_HTTP_PORT",
    3919,
    isPort,
    "an integer between 1 and 65535",
  ),
  NEWEGG_MCP_HTTP_BEARER_TOKEN: optionalTrimmedEnv(),
  NEWEGG_MCP_HTTP_ALLOWED_ORIGINS: csvEnv(),
  NEWEGG_MCP_HTTP_ALLOWED_HOSTS: csvEnv(),
});

/** Renders all collected issues into one secret-free message (a single line when there is one). */
function formatIssues(error: z.ZodError): string {
  const messages = [...new Set(error.issues.map((issue) => issue.message))];
  const [only] = messages;
  if (messages.length === 1 && only !== undefined) return only;
  return `Invalid MCP server configuration:\n${messages.map((m) => `  - ${m}`).join("\n")}`;
}

/**
 * Parses and validates configuration from an environment record (defaults to `process.env`).
 * Validates every variable in a single pass and throws one `McpConfigError` listing ALL problems
 * with actionable, secret-free messages.
 */
export function loadMcpConfigFromEnv(env: EnvRecord = process.env): McpServerConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new McpConfigError(formatIssues(result.error));
  }
  const parsed = result.data;

  const allowedMarketplaces = parsed.NEWEGG_MCP_ALLOWED_MARKETPLACES;
  if (allowedMarketplaces.length > 0 && !allowedMarketplaces.includes(parsed.NEWEGG_MARKETPLACE)) {
    throw new McpConfigError(
      `Configured NEWEGG_MARKETPLACE (${parsed.NEWEGG_MARKETPLACE}) is not present in NEWEGG_MCP_ALLOWED_MARKETPLACES; refusing to start.`,
    );
  }

  const credentials = makeCredentials(
    parsed.NEWEGG_SELLER_ID,
    parsed.NEWEGG_API_KEY,
    parsed.NEWEGG_SECRET_KEY,
  );

  const limits: McpLimits = {
    maxItemsPerOperation: parsed.NEWEGG_MCP_MAX_ITEMS_PER_OPERATION,
    previewTtlSeconds: parsed.NEWEGG_MCP_PREVIEW_TTL_SECONDS,
    allowZeroQuantity: parsed.NEWEGG_MCP_ALLOW_ZERO_QUANTITY,
    allowedWarehouses: parsed.NEWEGG_MCP_ALLOWED_WAREHOUSES,
    allowedMarketplaces,
  };

  const http: McpHttpConfig = {
    host: parsed.NEWEGG_MCP_HTTP_HOST,
    port: parsed.NEWEGG_MCP_HTTP_PORT,
    bearerToken: parsed.NEWEGG_MCP_HTTP_BEARER_TOKEN,
    allowedOrigins: parsed.NEWEGG_MCP_HTTP_ALLOWED_ORIGINS,
    allowedHosts: parsed.NEWEGG_MCP_HTTP_ALLOWED_HOSTS,
  };

  return {
    marketplace: parsed.NEWEGG_MARKETPLACE,
    baseUrl: parsed.NEWEGG_API_BASE_URL,
    allowWrites: parsed.NEWEGG_MCP_ALLOW_WRITES,
    credentials,
    limits,
    http,
  };
}
