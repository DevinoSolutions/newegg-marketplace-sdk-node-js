/**
 * Shared scaffolding for the ADR 0005 apply tools. Both inventory and listing apply tools consume
 * a single-use previewId, must reject the three consume failures distinctly, must reject a
 * previewId minted by a different operation type, and must append a "preview consumed" note to any
 * downstream failure. This module centralizes those so the two apply handlers keep only their
 * divergent success paths (updateMany vs create).
 *
 * Per ADR 0001 this layer is MCP-SDK-free.
 */
import type { PreviewRecord } from "../preview-store/index.js";
import {
  businessError,
  errorResult,
  type ToolContext,
  type ToolErrorPayload,
  type ToolResult,
} from "./shared.js";

const CONSUME_ERRORS: Record<
  "not_found" | "expired" | "already_used",
  { code: string; message: string }
> = {
  not_found: {
    code: "preview_not_found",
    message:
      "No preview matches that previewId. It may never have existed, was already consumed and " +
      "evicted, or the server restarted. Create a new preview and apply it.",
  },
  expired: {
    code: "preview_expired",
    message: "This preview has expired. Create a new preview and apply it within the TTL.",
  },
  already_used: {
    code: "preview_already_used",
    message: "This preview was already applied. Previews are single-use; create a new preview.",
  },
};

/** Outcome of {@link consumeTypedPreview}: either the kind-narrowed record or a ready error result. */
export type TypedPreviewOutcome<K extends PreviewRecord["kind"]> =
  { readonly record: Extract<PreviewRecord, { kind: K }> } | { readonly error: ToolResult };

/**
 * Atomically consumes a preview and asserts it is of `kind`. Returns the kind-narrowed record, or
 * a fully-formed error ToolResult for the three consume failures (not_found / expired /
 * already_used) or a kind mismatch (a previewId minted by a different operation type). The preview
 * is consumed even on a kind mismatch — a previewId is single-use regardless of which apply tool
 * receives it.
 */
export async function consumeTypedPreview<K extends PreviewRecord["kind"]>(
  ctx: ToolContext,
  previewId: string,
  kind: K,
): Promise<TypedPreviewOutcome<K>> {
  const consumed = await ctx.previewStore.consume(previewId);
  if (consumed.status !== "ok") {
    const mapped = CONSUME_ERRORS[consumed.status];
    return { error: errorResult(businessError(mapped.code, mapped.message)) };
  }
  if (consumed.record.kind !== kind) {
    return {
      error: errorResult(
        businessError(
          "preview_kind_mismatch",
          "This previewId belongs to a different operation type; apply it with its matching tool.",
        ),
      ),
    };
  }
  return { record: consumed.record as Extract<PreviewRecord, { kind: K }> };
}

/** Appends the single-use consumption note to a downstream apply failure (the preview is gone). */
export function appendConsumedNote(payload: ToolErrorPayload): ToolErrorPayload {
  payload.message = `${payload.message} The preview has been consumed and cannot be reused; create a new preview to retry.`;
  return payload;
}
