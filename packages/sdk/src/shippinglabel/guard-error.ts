import { NeweggValidationError } from "../errors/index.js";
import type { LabelCreateAttempt } from "../types.js";

/**
 * A label create was refused, with nothing sent, because an earlier create for the same order was
 * dispatched with an unknown outcome or already succeeded (T-6212). Newegg's order status can lag a
 * purchase that landed, so the order still reading unshipped does not prove no label was bought.
 * Verify the order (`orders.get` / `orders.getStatus`: a tracking number or a shipped status means
 * the label exists; the Seller Portal shows it too), then pass `attempt.attemptId` as
 * `acknowledgePriorAttemptId` to `previewCreate` / `create`. Never retried automatically.
 */
export class LabelCreateGuardError extends NeweggValidationError {
  readonly orderNumber: string;
  readonly attempt: LabelCreateAttempt;

  constructor(message: string, orderNumber: string, attempt: LabelCreateAttempt) {
    super(message, [{ path: "orderNumber", message: "a prior label create blocks this one" }]);
    this.name = "LabelCreateGuardError";
    this.orderNumber = orderNumber;
    this.attempt = attempt;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), orderNumber: this.orderNumber, attempt: this.attempt };
  }
}

/** The operator-facing text for a blocking attempt (no credentials, no customer data). */
export function priorAttemptMessage(
  orderNumber: string,
  attempt: LabelCreateAttempt,
  acknowledgementRejected: string | undefined,
): string {
  const what =
    attempt.state === "submitted"
      ? "completed (a label was bought)"
      : "was dispatched and its outcome is unknown (timeout, error or still in flight)";
  return (
    `A label create for order ${orderNumber} ${what} at ${attempt.atIso} (attempt ${attempt.attemptId}). ` +
    "Newegg's order status can lag, so the order still reading unshipped does not prove that no label " +
    "was bought, and a second create would buy and bill a second label. Nothing is retried " +
    "automatically. Verify the order first (orders.getStatus / orders.get: a shipped status or a " +
    "tracking number means the label exists; use reprint to fetch it, or check the Seller Portal), " +
    `and only if no label exists repeat the request with acknowledgePriorAttemptId "${attempt.attemptId}".` +
    (acknowledgementRejected === undefined ? "" : ` ${acknowledgementRejected}`)
  );
}
