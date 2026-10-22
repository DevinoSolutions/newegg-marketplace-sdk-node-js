/**
 * In-memory limiter for label reprints. A reprint may be billed and Newegg does not say (contracts
 * §23.1), and the single-use preview only stops one preview being applied twice, not an agent loop
 * that previews and applies the same order again and again. Two bounds, both always on:
 *
 * - a per-order cooldown (`labelReprintCooldownSeconds`): one reprint per order per window;
 * - a per-hour counter (`maxLabelReprintsPerHour`): reprints across ALL orders in any rolling hour.
 *
 * State lives in this process only, exactly like the in-memory preview store: it is lost on a
 * restart (the limit starts over), and it is not shared between server processes. A reprint counts
 * from the moment it is attempted, whatever the outcome: an indeterminate send may have been billed.
 */
import { underlyingPreviewStore, type PreviewStore } from "../preview-store/index.js";

const HOUR_MS = 3_600_000;

export interface ReprintLimits {
  readonly cooldownSeconds: number;
  readonly maxPerHour: number;
}

export class ReprintLimiter {
  private readonly byOrder = new Map<string, number>();
  private attempts: number[] = [];

  constructor(private readonly limits: ReprintLimits) {}

  /** The reason a reprint of `orderKey` is refused at `nowMs`, or undefined. Records nothing. */
  check(orderKey: string, nowMs: number): string | undefined {
    const last = this.byOrder.get(orderKey);
    const cooldownMs = this.limits.cooldownSeconds * 1000;
    if (last !== undefined && nowMs - last < cooldownMs) {
      const waitSeconds = Math.ceil((last + cooldownMs - nowMs) / 1000);
      return (
        `A label reprint of this order was already requested in the last ` +
        `${this.limits.cooldownSeconds} s (NEWEGG_MCP_LABEL_REPRINT_COOLDOWN_SECONDS); a reprint may ` +
        `be charged, so wait about ${waitSeconds} s and check the order's label before requesting another.`
      );
    }
    const recent = this.attempts.filter((at) => nowMs - at < HOUR_MS);
    if (recent.length >= this.limits.maxPerHour) {
      const oldest = Math.min(...recent);
      const waitMinutes = Math.ceil((oldest + HOUR_MS - nowMs) / 60_000);
      return (
        `${recent.length} label reprints were already requested in the last hour ` +
        `(NEWEGG_MCP_MAX_LABEL_REPRINTS_PER_HOUR=${this.limits.maxPerHour}); a reprint may be charged, ` +
        `so wait about ${waitMinutes} min. The count resets when the server restarts.`
      );
    }
    return undefined;
  }

  /**
   * Check-and-record in one synchronous step (so two concurrent applies cannot both pass): the
   * refusal reason, or undefined once the attempt is recorded.
   */
  reserve(orderKey: string, nowMs: number): string | undefined {
    const refused = this.check(orderKey, nowMs);
    if (refused !== undefined) return refused;
    this.byOrder.set(orderKey, nowMs);
    this.attempts = this.attempts.filter((at) => nowMs - at < HOUR_MS);
    this.attempts.push(nowMs);
    return undefined;
  }
}

/**
 * One limiter per underlying preview store, i.e. per server process, so both reset together on
 * restart. Keyed on the store behind the per-session view: in HTTP mode every session gets its own
 * view of the one shared store, and a limiter per view would reset by opening a new session.
 */
const limiters = new WeakMap<PreviewStore, ReprintLimiter>();

export function reprintLimiterFor(store: PreviewStore, limits: ReprintLimits): ReprintLimiter {
  const shared = underlyingPreviewStore(store);
  let limiter = limiters.get(shared);
  if (limiter === undefined) {
    limiter = new ReprintLimiter(limits);
    limiters.set(shared, limiter);
  }
  return limiter;
}
