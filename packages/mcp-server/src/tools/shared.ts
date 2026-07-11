/**
 * Shared building blocks for the pure tool layer: zod schemas, the tool-context and
 * tool-result contracts, structured error mapping, and small serialization helpers.
 *
 * Per ADR 0001 this layer is MCP-SDK-free: tool handlers are plain async functions returning
 * plain data, unit-testable without an MCP client. The `server/` layer adapts these into MCP
 * registrations.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NeweggError } from "@devino/newegg-marketplace-sdk";
import type {
  ItemCondition,
  ItemIdentifier,
  NeweggClient,
  RateLimitInfo,
} from "@devino/newegg-marketplace-sdk";
import type { McpServerConfig } from "../config/index.js";
import type { PreviewStore } from "../preview-store/index.js";

// ---------------------------------------------------------------------------
// logging + context
// ---------------------------------------------------------------------------
export type LogLevel = "debug" | "info" | "warn" | "error";
/** Structured JSON-lines logger. Implementations must write to stderr only. */
export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

/** Everything a tool handler needs at call time. The clock is injectable for tests. */
export interface ToolContext {
  readonly client: NeweggClient;
  readonly config: McpServerConfig;
  readonly previewStore: PreviewStore;
  readonly logger: Logger;
  readonly now: () => Date;
}

// ---------------------------------------------------------------------------
// tool definition + result contracts
// ---------------------------------------------------------------------------
/** Structurally compatible with the MCP SDK's `ToolAnnotations`; defined locally to keep the
 * tool layer free of MCP imports. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Structured, leak-safe error payload returned to callers as `isError` tool results. */
export interface ToolErrorPayload {
  errorCode: string;
  message: string;
  correlationId?: string;
  neweggErrorCode?: string;
  httpStatus?: number;
  retryable?: boolean;
}

export type ToolResult =
  | { readonly ok: true; readonly structuredContent: Record<string, unknown> }
  | { readonly ok: false; readonly error: ToolErrorPayload };

export function okResult(structuredContent: Record<string, unknown>): ToolResult {
  return { ok: true, structuredContent };
}

export function errorResult(error: ToolErrorPayload): ToolResult {
  return { ok: false, error };
}

/** A self-describing, MCP-agnostic tool definition consumed by the `server/` registration. */
export interface ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly handler: (input: z.infer<InputSchema>, ctx: ToolContext) => Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------
/**
 * Maps a thrown error into the structured tool-error payload. `NeweggError` instances carry
 * sanitized, secret-free messages (SDK guarantee), so their fields are surfaced directly.
 * Any other (unexpected) error is reduced to a generic "internal error" plus a correlation id;
 * the real details are logged to stderr only.
 */
export function mapErrorToPayload(error: unknown, logger: Logger): ToolErrorPayload {
  if (error instanceof NeweggError) {
    const payload: ToolErrorPayload = {
      errorCode: error.code ?? "internal",
      message: error.message,
      retryable: error.retryable,
    };
    if (error.correlationId !== undefined) {
      payload.correlationId = error.correlationId;
    }
    if (error.neweggErrorCode !== undefined) {
      payload.neweggErrorCode = error.neweggErrorCode;
    }
    if (error.httpStatus !== undefined) {
      payload.httpStatus = error.httpStatus;
    }
    return payload;
  }
  const correlationId = randomUUID();
  logger("error", "unexpected_tool_error", {
    correlationId,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return { errorCode: "internal", message: "internal error", correlationId };
}

/** Builds a business-rule (policy) error payload. */
export function businessError(errorCode: string, message: string): ToolErrorPayload {
  return { errorCode, message };
}

// ---------------------------------------------------------------------------
// shared schemas
// ---------------------------------------------------------------------------
export const marketplaceSchema = z.enum(["us", "b2b", "ca"]);

export const conditionSchema = z.enum([
  "new",
  "refurbished",
  "usedLikeNew",
  "usedVeryGood",
  "usedGood",
  "usedAcceptable",
]);

/** Identifier input accepted by tools. Strict: unknown keys are rejected. */
export const identifierInputSchema = z
  .strictObject({
    type: z.enum(["sellerPartNumber", "neweggItemNumber", "upc"]).describe("Identifier kind."),
    value: z.string().min(1).max(64).describe("The identifier value."),
    condition: conditionSchema
      .optional()
      .describe("Item condition; only meaningful for UPC identifiers."),
  })
  .describe("A single item identifier.");

export type IdentifierInput = z.infer<typeof identifierInputSchema>;

/** Identifier shape as echoed back in outputs (e.g. missingIdentifiers). */
export const identifierOutputSchema = z.object({
  type: z.enum(["sellerPartNumber", "neweggItemNumber", "upc"]),
  value: z.string(),
  condition: conditionSchema.optional(),
});

/** Rate-limit info as surfaced in outputs — reset instants are ISO strings, never Date. */
export const rateLimitOutputSchema = z.object({
  requestLimit: z.number().optional(),
  requestRemaining: z.number().optional(),
  requestResetAt: z.string().optional(),
  recordLimit: z.number().optional(),
  recordRemaining: z.number().optional(),
  recordResetAt: z.string().optional(),
});

// ---------------------------------------------------------------------------
// mapping helpers
// ---------------------------------------------------------------------------
/** Converts a validated identifier input into the SDK's discriminated `ItemIdentifier`,
 * attaching `condition` only for UPC identifiers (the only kind that carries one). */
export function toItemIdentifier(input: IdentifierInput): ItemIdentifier {
  if (input.type === "upc") {
    return input.condition !== undefined
      ? { type: "upc", value: input.value, condition: input.condition }
      : { type: "upc", value: input.value };
  }
  if (input.type === "neweggItemNumber") {
    return { type: "neweggItemNumber", value: input.value };
  }
  return { type: "sellerPartNumber", value: input.value };
}

/** Serializes SDK rate-limit info into a JSON-safe object (Date -> ISO), or undefined. */
export function serializeRateLimit(
  info: RateLimitInfo | undefined,
): Record<string, unknown> | undefined {
  if (info === undefined) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  if (info.requestLimit !== undefined) out.requestLimit = info.requestLimit;
  if (info.requestRemaining !== undefined) out.requestRemaining = info.requestRemaining;
  if (info.requestResetAt !== undefined) out.requestResetAt = info.requestResetAt.toISOString();
  if (info.recordLimit !== undefined) out.recordLimit = info.recordLimit;
  if (info.recordRemaining !== undefined) out.recordRemaining = info.recordRemaining;
  if (info.recordResetAt !== undefined) out.recordResetAt = info.recordResetAt.toISOString();
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The condition value from an identifier, when present (only UPC identifiers carry one). */
export function conditionOf(identifier: ItemIdentifier): ItemCondition | undefined {
  return identifier.type === "upc" ? identifier.condition : undefined;
}
