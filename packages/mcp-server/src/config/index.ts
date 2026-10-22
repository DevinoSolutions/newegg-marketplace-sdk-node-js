/**
 * Environment-driven configuration for the MCP server. `loadMcpConfigFromEnv` parses and
 * validates process env into a typed `McpServerConfig`, separating credentials (redacted on
 * serialization) from limits and HTTP settings so accidental logging of the config object can
 * never leak secrets. This module never imports the MCP SDK (ADR 0001).
 */
import { readFileSync } from "node:fs";
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
  /**
   * Largest absolute percent change a single price update may make versus the item's current
   * price; a bigger move is blocked at preview time (fat-finger guard). Default 50.
   */
  readonly maxPriceChangePercent: number;
  /**
   * Largest amount of money a single RMA refund or courtesy refund may move, in the marketplace
   * currency; a bigger one is blocked at preview time (fat-finger / runaway-agent guard). Default 500.
   */
  readonly maxRefundAmount: number;
  /**
   * Ceiling on what ONE shipping label purchase (all its packages together) may cost, in the
   * marketplace currency (USD on us/b2b, CAD on ca; the number is compared as-is); a dearer
   * purchase is blocked at preview and again at apply. Default 100. `undefined` means NO cap and is
   * reachable only through the explicit `NEWEGG_MCP_MAX_LABEL_AMOUNT=unlimited` (or `off`) opt-out,
   * never by leaving the variable unset or empty. While a cap is set, a cost that cannot be
   * determined (failed quote, unrated package, any reprint) is blocked too (fail closed), unless
   * `allowLabelReprint` lets reprints through.
   */
  readonly maxLabelAmount: number | undefined;
  /**
   * Lets a label reprint be previewed and applied while `maxLabelAmount` is a cap. A reprint has no
   * quote and Newegg does not say whether it is billed (contracts §23.1), so it is blocked under a
   * cap by default; this is the explicit opt-in (`NEWEGG_MCP_ALLOW_LABEL_REPRINT=true`, exact
   * literal) for recovering a label after an indeterminate create without lifting the create cap.
   * It still needs `NEWEGG_MCP_ALLOW_WRITES=true` (the reprint tools do not exist without it), so
   * the raw flag is not the effective permission: the resources report `allowWrites && flag`.
   */
  readonly allowLabelReprint: boolean;
  /**
   * Per-order reprint cooldown in seconds (default 600): a second reprint of the same order inside
   * the window is refused at apply. Always on (1..86400); in-memory, resets on restart.
   */
  readonly labelReprintCooldownSeconds: number;
  /**
   * Reprints allowed across all orders in any rolling hour (default 6), enforced at apply. Always
   * on (1..1000); in-memory, resets on restart.
   */
  readonly maxLabelReprintsPerHour: number;
  /** Uppercased warehouse codes; empty means "all warehouses allowed". */
  readonly allowedWarehouses: string[];
  /** Normalized marketplace codes; empty means "all marketplaces allowed". */
  readonly allowedMarketplaces: NeweggMarketplace[];
}

export interface McpHttpConfig {
  readonly host: string;
  readonly port: number;
  /** At least 32 characters when set (T-5672). */
  readonly bearerToken?: string;
  readonly allowedOrigins: string[];
  readonly allowedHosts: string[];
  /** Concurrent MCP sessions accepted (default 32); the next initialize gets 503. */
  readonly maxSessions?: number;
  /** A session with no request for this many seconds is closed (default 1800). */
  readonly sessionIdleTtlSeconds?: number;
  /**
   * Operator declaration that a TLS-terminating proxy fronts this listener. The transport itself is
   * plain HTTP: without this flag a non-loopback bind logs a warning at startup.
   */
  readonly behindTlsProxy?: boolean;
}

/** Shortest accepted `NEWEGG_MCP_HTTP_BEARER_TOKEN` (e.g. `openssl rand -hex 16`). */
const MIN_BEARER_TOKEN_LENGTH = 32;
/** Fewest distinct characters a bearer token must contain (rejects `aaaa...` and `abab...`). */
const MIN_BEARER_TOKEN_DISTINCT = 12;

/**
 * Why `token` is too weak to guard the HTTP transport, or undefined when it is acceptable: shorter
 * than 32 characters, or fewer than 12 distinct characters. The reason never contains the token.
 */
export function weakBearerTokenReason(token: string): string | undefined {
  if (token.length < MIN_BEARER_TOKEN_LENGTH) {
    return `must be at least ${MIN_BEARER_TOKEN_LENGTH} characters`;
  }
  if (new Set(token).size < MIN_BEARER_TOKEN_DISTINCT) {
    return `must contain at least ${MIN_BEARER_TOKEN_DISTINCT} different characters`;
  }
  return undefined;
}
/** Defaults for the HTTP session bounds (T-5670). */
export const DEFAULT_MAX_HTTP_SESSIONS = 32;
export const DEFAULT_SESSION_IDLE_TTL_SECONDS = 1800;

export interface McpServerConfig {
  readonly marketplace: NeweggMarketplace;
  /**
   * The marketplace the credentials were issued for. Always equals `marketplace` once
   * `loadMcpConfigFromEnv` succeeds (a mismatch refuses to start); it is passed to the SDK as
   * `credentialMarketplace` so the client re-checks the binding (T-5911, ADR 0006).
   */
  readonly credentialMarketplace: NeweggMarketplace;
  /** Trusted-config-only base URL override; never exposed through MCP tools/resources. */
  readonly baseUrl?: string;
  /**
   * `NEWEGG_MCP_ALLOW_CUSTOM_BASE_URL=true`: lets `baseUrl` name a non-newegg.com https host.
   * Off by default because the API keys and seller ID are sent to that host (T-6217).
   */
  readonly allowCustomBaseUrl?: boolean;
  readonly allowWrites: boolean;
  /**
   * Opt-in (`NEWEGG_MCP_REPORT_FTPS=true`, exact literal): the built-in report file download uses
   * explicit FTPS (T-5668). Default is plain FTP: Newegg's server presents a self-signed
   * certificate, so FTPS also needs `reportFtpsCa` (the certificate's PEM, read from
   * `NEWEGG_MCP_REPORT_FTPS_CA_FILE`, so the chain validates) and `reportFtpsCertSha256`
   * (`NEWEGG_MCP_REPORT_FTPS_CERT_SHA256`, the fingerprint it must have). Certificate validation is
   * never disabled. With FTPS on there is no fallback to clear text.
   */
  readonly reportFtps?: boolean;
  readonly reportFtpsCertSha256?: string;
  /** PEM text of the certificate(s) trusted for the report FTPS handshake. */
  readonly reportFtpsCa?: string;
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

/**
 * Strict plain-decimal money: no sign, exponent, hex/binary/octal prefix, leading zeros, bare
 * leading/trailing dot or inner whitespace (`Number()` accepts all of those), at most 5 integer
 * digits and 2 decimals.
 */
const STRICT_MONEY = /^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/;

/** Strict plain positive integer (digits only, no sign, exponent, prefix or leading zero), up to 5 digits. */
const STRICT_COUNT = /^[1-9]\d{0,4}$/;

/**
 * Optional safety limit with a default, parsed as a strict plain decimal ({@link STRICT_MONEY}) that
 * must satisfy `check` (`Number()` alone would accept `0x1F4`, `1e3`, `+5`, `Infinity`). Unlike
 * {@link cappedNumberEnv} there is no way to switch it off. The message names the variable only: a
 * rejected safety value is never echoed back.
 */
function strictNumberEnv(
  name: string,
  fallback: number,
  check: (n: number) => boolean,
  hint: string,
) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const trimmed = raw?.trim();
      if (trimmed === undefined || trimmed === "") return fallback;
      const parsed = STRICT_MONEY.test(trimmed) ? Number(trimmed) : Number.NaN;
      if (!Number.isFinite(parsed) || !check(parsed)) {
        ctx.addIssue({ code: "custom", message: `${name} must be ${hint}.` });
        return z.NEVER;
      }
      return parsed;
    });
}

/** Optional safety limit with a default, parsed as a strict plain positive integer ({@link STRICT_COUNT}). */
function strictCountEnv(name: string, fallback: number, max: number) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const trimmed = raw?.trim();
      if (trimmed === undefined || trimmed === "") return fallback;
      const parsed = STRICT_COUNT.test(trimmed) ? Number(trimmed) : Number.NaN;
      if (!Number.isFinite(parsed) || parsed > max) {
        ctx.addIssue({
          code: "custom",
          message: `${name} must be a plain whole number from 1 to ${max} (digits only).`,
        });
        return z.NEVER;
      }
      return parsed;
    });
}

/** The only spellings (case-insensitive) that switch a safety cap off. */
const CAP_DISABLED_TOKENS: readonly string[] = ["unlimited", "off"];

/**
 * Safety cap with a default: unset/blank yields `fallback` (never "no cap"), a value must be a strict
 * plain decimal ({@link STRICT_MONEY}) satisfying `check`, and the cap is disabled (`undefined`) only by an explicit `unlimited` / `off`.
 */
function cappedNumberEnv(
  name: string,
  fallback: number,
  check: (n: number) => boolean,
  hint: string,
) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): number | undefined => {
      const trimmed = raw?.trim();
      if (trimmed === undefined || trimmed === "") return fallback;
      if (CAP_DISABLED_TOKENS.includes(trimmed.toLowerCase())) return undefined;
      const parsed = STRICT_MONEY.test(trimmed) ? Number(trimmed) : Number.NaN;
      if (!Number.isFinite(parsed) || !check(parsed)) {
        // The message names the variable only: a rejected safety value is never echoed back.
        ctx.addIssue({
          code: "custom",
          message: `${name} must be ${hint}, or "unlimited" to disable the cap.`,
        });
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

/**
 * The PEM text of `NEWEGG_MCP_REPORT_FTPS_CA_FILE`, or undefined when unset/blank. A missing,
 * unreadable or non-PEM file refuses to start; the message names the variable, never the content.
 */
function readReportFtpsCa(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  let text: string;
  try {
    text = readFileSync(trimmed, "utf8");
  } catch {
    throw new McpConfigError("NEWEGG_MCP_REPORT_FTPS_CA_FILE cannot be read.");
  }
  if (!text.includes("-----BEGIN CERTIFICATE-----")) {
    throw new McpConfigError("NEWEGG_MCP_REPORT_FTPS_CA_FILE must hold a PEM certificate.");
  }
  return text;
}

/**
 * Optional HTTP bearer token: undefined when unset/blank, otherwise a token that passes
 * {@link weakBearerTokenReason}. The message names the variable and the rule only: a rejected token
 * is never echoed back.
 */
function bearerTokenEnv(name: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const trimmed = raw?.trim();
      if (trimmed === undefined || trimmed.length === 0) return undefined;
      const weakness = weakBearerTokenReason(trimmed);
      if (weakness !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `${name} ${weakness} (generate one with \`openssl rand -hex 32\`).`,
        });
        return z.NEVER;
      }
      return trimmed;
    });
}

const envSchema = z.object({
  // Credentials are resolved separately (see resolveCredentials): they depend on the marketplace.
  NEWEGG_MARKETPLACE: marketplaceEnv("NEWEGG_MARKETPLACE"),
  NEWEGG_API_BASE_URL: urlEnv("NEWEGG_API_BASE_URL"),
  // SECURITY gate, same exact-literal rule as NEWEGG_MCP_ALLOW_WRITES: only "true" opts in.
  NEWEGG_MCP_ALLOW_CUSTOM_BASE_URL: z
    .string()
    .optional()
    .transform((raw) => raw === "true"),
  // SECURITY gate: only the EXACT literal "true" enables writes. "1"/"TRUE"/" true "/unset all
  // stay false. Kept as a raw `=== "true"` (no trim/lowercase) so the surface can't widen by accident.
  NEWEGG_MCP_ALLOW_WRITES: z
    .string()
    .optional()
    .transform((raw) => raw === "true"),
  // SECURITY gate, same exact-literal rule as NEWEGG_MCP_ALLOW_WRITES: only "true" opts in.
  NEWEGG_MCP_REPORT_FTPS: z
    .string()
    .optional()
    .transform((raw) => raw === "true"),
  NEWEGG_MCP_REPORT_FTPS_CERT_SHA256: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const trimmed = raw?.trim();
      if (trimmed === undefined || trimmed === "") return undefined;
      if (!/^[0-9a-f]{2}(:?[0-9a-f]{2}){31}$/i.test(trimmed)) {
        ctx.addIssue({
          code: "custom",
          message: "NEWEGG_MCP_REPORT_FTPS_CERT_SHA256 must be a SHA-256 hex fingerprint.",
        });
        return z.NEVER;
      }
      return trimmed;
    }),
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
  NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT: strictNumberEnv(
    "NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT",
    50,
    (n) => n > 0 && n <= 10_000,
    "a plain decimal (digits, optional point, up to 2 decimals, e.g. 50 or 12.5) greater than 0 and at most 10000",
  ),
  NEWEGG_MCP_MAX_REFUND_AMOUNT: strictNumberEnv(
    "NEWEGG_MCP_MAX_REFUND_AMOUNT",
    500,
    (n) => n > 0 && n <= 99_999.99,
    "a plain decimal (digits, optional point, up to 2 decimals, e.g. 500 or 49.99) greater than 0 and at most 99999.99",
  ),
  NEWEGG_MCP_MAX_LABEL_AMOUNT: cappedNumberEnv(
    "NEWEGG_MCP_MAX_LABEL_AMOUNT",
    100,
    (n) => n > 0 && n <= 99_999.99,
    "a plain decimal (digits, optional point, up to 2 decimals, e.g. 100 or 49.99) greater than 0 and at most 99999.99",
  ),
  // SECURITY gate, same exact-literal rule as NEWEGG_MCP_ALLOW_WRITES: only "true" opts in.
  NEWEGG_MCP_ALLOW_LABEL_REPRINT: z
    .string()
    .optional()
    .transform((raw) => raw === "true"),
  NEWEGG_MCP_LABEL_REPRINT_COOLDOWN_SECONDS: strictCountEnv(
    "NEWEGG_MCP_LABEL_REPRINT_COOLDOWN_SECONDS",
    600,
    86_400,
  ),
  NEWEGG_MCP_MAX_LABEL_REPRINTS_PER_HOUR: strictCountEnv(
    "NEWEGG_MCP_MAX_LABEL_REPRINTS_PER_HOUR",
    6,
    1000,
  ),
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
  NEWEGG_MCP_HTTP_BEARER_TOKEN: bearerTokenEnv("NEWEGG_MCP_HTTP_BEARER_TOKEN"),
  NEWEGG_MCP_HTTP_ALLOWED_ORIGINS: csvEnv(),
  NEWEGG_MCP_HTTP_ALLOWED_HOSTS: csvEnv(),
  NEWEGG_MCP_HTTP_MAX_SESSIONS: strictCountEnv(
    "NEWEGG_MCP_HTTP_MAX_SESSIONS",
    DEFAULT_MAX_HTTP_SESSIONS,
    10000,
  ),
  NEWEGG_MCP_HTTP_SESSION_IDLE_SECONDS: strictCountEnv(
    "NEWEGG_MCP_HTTP_SESSION_IDLE_SECONDS",
    DEFAULT_SESSION_IDLE_TTL_SECONDS,
    86400,
  ),
  // Exact-literal opt-in, like the write gates: only "true" declares a TLS proxy in front.
  NEWEGG_MCP_HTTP_BEHIND_TLS_PROXY: z
    .string()
    .optional()
    .transform((raw) => raw === "true"),
});

const CREDENTIAL_FIELDS = ["SELLER_ID", "API_KEY", "SECRET_KEY"] as const;

const isSet = (env: EnvRecord, name: string): boolean => (env[name]?.trim() ?? "") !== "";

const prefixedCredentialNames = (marketplace: NeweggMarketplace): string[] =>
  CREDENTIAL_FIELDS.map((field) => `NEWEGG_${marketplace.toUpperCase()}_${field}`);

type CredentialOutcome =
  | { readonly credentials: McpCredentials; readonly issues: readonly [] }
  | { readonly credentials?: undefined; readonly issues: readonly string[] };

/** Builds the credentials holder from three env variable names that are known to be set. */
function credentialsFrom(env: EnvRecord, names: readonly string[]): McpCredentials {
  const [sellerId, apiKey, secretKey] = names.map((name) => env[name]?.trim() ?? "");
  return makeCredentials(sellerId ?? "", apiKey ?? "", secretKey ?? "");
}

/**
 * Resolves the credential set for the SELECTED marketplace (T-5911, ADR 0006). Newegg
 * authenticates on seller id + key pair only and ignores the URL prefix, so keys from one
 * marketplace's seller account would silently serve that account under any other marketplace.
 *
 * 1. If any `NEWEGG_<MP>_{SELLER_ID,API_KEY,SECRET_KEY}` is set for the selected marketplace, all
 *    three are required and used.
 * 2. Otherwise the legacy unprefixed `NEWEGG_{SELLER_ID,API_KEY,SECRET_KEY}` are accepted only
 *    when `NEWEGG_CREDENTIALS_MARKETPLACE` names the marketplace they were issued for AND equals
 *    `NEWEGG_MARKETPLACE`.
 * 3. Never a fallback to another marketplace's set. Messages name variables and marketplaces only,
 *    never values.
 *
 * A `NEWEGG_CREDENTIALS_MARKETPLACE` that contradicts `NEWEGG_MARKETPLACE` is refused even when a
 * prefixed set is present. Unprefixed legacy variables left in the environment next to a prefixed set
 * are ignored (the prefixed set wins and is the only one used).
 */
function resolveCredentials(env: EnvRecord, marketplace: NeweggMarketplace): CredentialOutcome {
  const prefixed = prefixedCredentialNames(marketplace);
  if (prefixed.some((name) => isSet(env, name))) {
    const issues: string[] = [];
    const missing = prefixed.filter((name) => !isSet(env, name));
    if (missing.length > 0) {
      issues.push(
        `Incomplete credential set for marketplace "${marketplace}": ${missing.join(", ")} not set. ` +
          `When any of ${prefixed.join("/")} is set, all three are required.`,
      );
    }
    const declared = env["NEWEGG_CREDENTIALS_MARKETPLACE"]?.trim() ?? "";
    if (declared !== "") {
      const declaredMarketplace = normalizeMarketplace(declared);
      if (declaredMarketplace === undefined) {
        issues.push(marketplaceHint("NEWEGG_CREDENTIALS_MARKETPLACE"));
      } else if (declaredMarketplace !== marketplace) {
        issues.push(
          `NEWEGG_CREDENTIALS_MARKETPLACE (${declaredMarketplace}) contradicts NEWEGG_MARKETPLACE ` +
            `(${marketplace}) while ${prefixed.join("/")} are set; refusing to start. Remove or fix ` +
            `NEWEGG_CREDENTIALS_MARKETPLACE (it is not needed with the prefixed names).`,
        );
      }
    }
    if (issues.length > 0) return { issues };
    return { credentials: credentialsFrom(env, prefixed), issues: [] };
  }

  const legacy = CREDENTIAL_FIELDS.map((field) => `NEWEGG_${field}`);
  const missingLegacy = legacy.filter((name) => !isSet(env, name));
  if (missingLegacy.length === legacy.length) {
    const others = (["us", "b2b", "ca"] as const)
      .filter((other) => other !== marketplace)
      .filter((other) => prefixedCredentialNames(other).some((name) => isSet(env, name)));
    const hint =
      others.length > 0
        ? ` Credentials for ${others.join(", ")} are set but are never reused for another marketplace.`
        : "";
    return {
      issues: [
        `No credentials configured for NEWEGG_MARKETPLACE=${marketplace}: set ${prefixed.join(", ")} ` +
          `(the keys issued for that marketplace), or the unprefixed ${legacy.join(", ")} together ` +
          `with NEWEGG_CREDENTIALS_MARKETPLACE=${marketplace}.${hint}`,
      ],
    };
  }

  const issues: string[] = missingLegacy.map(required);
  const declared = env["NEWEGG_CREDENTIALS_MARKETPLACE"]?.trim() ?? "";
  if (declared === "") {
    issues.push(
      `NEWEGG_CREDENTIALS_MARKETPLACE is required with the unprefixed ${legacy.join("/")}: set it ` +
        `to the marketplace those keys were issued for (us, b2b or ca); it must equal ` +
        `NEWEGG_MARKETPLACE (${marketplace}). Newegg ignores the URL prefix when authenticating, ` +
        `so unlabeled keys could silently operate another marketplace's account. Alternatively ` +
        `use ${prefixed.join("/")}.`,
    );
  } else {
    const declaredMarketplace = normalizeMarketplace(declared);
    if (declaredMarketplace === undefined) {
      issues.push(marketplaceHint("NEWEGG_CREDENTIALS_MARKETPLACE"));
    } else if (declaredMarketplace !== marketplace) {
      issues.push(
        `NEWEGG_CREDENTIALS_MARKETPLACE (${declaredMarketplace}) does not match ` +
          `NEWEGG_MARKETPLACE (${marketplace}); refusing to start. Set ` +
          `NEWEGG_MARKETPLACE=${declaredMarketplace}, or provide the keys issued for ` +
          `${marketplace} as ${prefixed.join("/")}.`,
      );
    }
  }
  if (issues.length > 0) return { issues };
  return { credentials: credentialsFrom(env, legacy), issues: [] };
}

/** Renders all collected issues into one secret-free message (a single line when there is one). */
function formatIssues(allMessages: readonly string[]): string {
  const messages = [...new Set(allMessages)];
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
  const rawMarketplace = env["NEWEGG_MARKETPLACE"]?.trim() ?? "";
  const selected = result.success
    ? result.data.NEWEGG_MARKETPLACE
    : rawMarketplace === ""
      ? undefined
      : normalizeMarketplace(rawMarketplace);
  // Credentials depend on the selected marketplace; with no valid one the marketplace issue is
  // already reported and there is nothing sound to resolve them against.
  const outcome = selected === undefined ? undefined : resolveCredentials(env, selected);
  if (!result.success || outcome?.credentials === undefined) {
    throw new McpConfigError(
      formatIssues([
        ...(result.success ? [] : result.error.issues.map((issue) => issue.message)),
        ...(outcome?.issues ?? []),
      ]),
    );
  }
  const parsed = result.data;
  const credentials = outcome.credentials;

  const allowedMarketplaces = parsed.NEWEGG_MCP_ALLOWED_MARKETPLACES;
  if (allowedMarketplaces.length > 0 && !allowedMarketplaces.includes(parsed.NEWEGG_MARKETPLACE)) {
    throw new McpConfigError(
      `Configured NEWEGG_MARKETPLACE (${parsed.NEWEGG_MARKETPLACE}) is not present in NEWEGG_MCP_ALLOWED_MARKETPLACES; refusing to start.`,
    );
  }

  const reportFtpsCa = readReportFtpsCa(env["NEWEGG_MCP_REPORT_FTPS_CA_FILE"]);
  if (
    (reportFtpsCa !== undefined || parsed.NEWEGG_MCP_REPORT_FTPS_CERT_SHA256 !== undefined) &&
    !parsed.NEWEGG_MCP_REPORT_FTPS
  ) {
    throw new McpConfigError(
      "NEWEGG_MCP_REPORT_FTPS_CERT_SHA256 / NEWEGG_MCP_REPORT_FTPS_CA_FILE only apply with NEWEGG_MCP_REPORT_FTPS=true; without it the report download would silently stay plain FTP.",
    );
  }
  if (parsed.NEWEGG_MCP_REPORT_FTPS_CERT_SHA256 !== undefined && reportFtpsCa === undefined) {
    throw new McpConfigError(
      "NEWEGG_MCP_REPORT_FTPS_CERT_SHA256 needs NEWEGG_MCP_REPORT_FTPS_CA_FILE (the PEM of the pinned certificate): certificate validation is never disabled, so a self-signed certificate must be trusted explicitly.",
    );
  }

  const limits: McpLimits = {
    maxItemsPerOperation: parsed.NEWEGG_MCP_MAX_ITEMS_PER_OPERATION,
    previewTtlSeconds: parsed.NEWEGG_MCP_PREVIEW_TTL_SECONDS,
    allowZeroQuantity: parsed.NEWEGG_MCP_ALLOW_ZERO_QUANTITY,
    maxPriceChangePercent: parsed.NEWEGG_MCP_MAX_PRICE_CHANGE_PERCENT,
    maxRefundAmount: parsed.NEWEGG_MCP_MAX_REFUND_AMOUNT,
    maxLabelAmount: parsed.NEWEGG_MCP_MAX_LABEL_AMOUNT,
    allowLabelReprint: parsed.NEWEGG_MCP_ALLOW_LABEL_REPRINT,
    labelReprintCooldownSeconds: parsed.NEWEGG_MCP_LABEL_REPRINT_COOLDOWN_SECONDS,
    maxLabelReprintsPerHour: parsed.NEWEGG_MCP_MAX_LABEL_REPRINTS_PER_HOUR,
    allowedWarehouses: parsed.NEWEGG_MCP_ALLOWED_WAREHOUSES,
    allowedMarketplaces,
  };

  const http: McpHttpConfig = {
    host: parsed.NEWEGG_MCP_HTTP_HOST,
    port: parsed.NEWEGG_MCP_HTTP_PORT,
    bearerToken: parsed.NEWEGG_MCP_HTTP_BEARER_TOKEN,
    allowedOrigins: parsed.NEWEGG_MCP_HTTP_ALLOWED_ORIGINS,
    allowedHosts: parsed.NEWEGG_MCP_HTTP_ALLOWED_HOSTS,
    maxSessions: parsed.NEWEGG_MCP_HTTP_MAX_SESSIONS,
    sessionIdleTtlSeconds: parsed.NEWEGG_MCP_HTTP_SESSION_IDLE_SECONDS,
    behindTlsProxy: parsed.NEWEGG_MCP_HTTP_BEHIND_TLS_PROXY,
  };

  return {
    marketplace: parsed.NEWEGG_MARKETPLACE,
    credentialMarketplace: parsed.NEWEGG_MARKETPLACE,
    baseUrl: parsed.NEWEGG_API_BASE_URL,
    allowCustomBaseUrl: parsed.NEWEGG_MCP_ALLOW_CUSTOM_BASE_URL,
    allowWrites: parsed.NEWEGG_MCP_ALLOW_WRITES,
    reportFtps: parsed.NEWEGG_MCP_REPORT_FTPS,
    reportFtpsCertSha256: parsed.NEWEGG_MCP_REPORT_FTPS_CERT_SHA256,
    ...(reportFtpsCa === undefined ? {} : { reportFtpsCa }),
    credentials,
    limits,
    http,
  };
}
