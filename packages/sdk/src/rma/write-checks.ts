/**
 * Pure pre-write checks for the RMA and courtesy-refund WRITES (contracts §20.7). They take what a
 * READ of the order, its RMAs and its courtesy refunds returned and decide what Newegg would reject
 * (the `SE0xx` rules the pages list) and what only a read can reveal (a duplicate RMA, a refund
 * above the order's remaining balance). Nothing here talks to the network; money is compared in
 * whole cents. A blocker means the write must not be sent; a warning is information for a human.
 */
import type { CourtesyRefund, Order, Rma, RmaItem, RmaWriteItem, RmaType } from "../types.js";
import { fromCents, toCents } from "./write-constants.js";

/** What reads returned about one order. */
export interface OrderContext {
  order: Order | undefined;
  /** RMAs already on the order (any status). */
  rmas: Rma[];
  /** Courtesy refunds already on the order (any status). */
  courtesyRefunds: CourtesyRefund[];
}

/** Accumulator for one check run. */
export interface Findings {
  blockers: string[];
  warnings: string[];
}

export function newFindings(): Findings {
  return { blockers: [], warnings: [] };
}

const money = (cents: number): string => fromCents(cents).toFixed(2);

/** An RMA that still counts against the returnable quantity and the refundable balance. */
function isActiveRma(rma: Rma): boolean {
  return rma.status !== "rejected" && rma.status !== "voided";
}

/** Refund an RMA line records: quantity x refund per unit + shipping refund, in cents. */
function lineRefundCents(item: RmaItem): number {
  const unit = item.returnUnitPrice ?? 0;
  const quantity = item.returnQuantity ?? 0;
  return toCents(unit) * quantity + toCents(item.refundShippingPrice ?? 0);
}

/** Total an existing RMA refunds, in cents (0 for a replacement RMA). */
export function rmaRefundCents(rma: Pick<Rma, "type" | "items">): number {
  if (rma.type !== "refund") return 0;
  return rma.items.reduce((sum, item) => sum + lineRefundCents(item), 0);
}

/** Money already refunded on the order by other RMAs and courtesy refunds, in cents. */
function priorRefundCents(context: OrderContext, excludeRmaNumber?: string): number {
  const fromRmas = context.rmas
    .filter((rma) => isActiveRma(rma) && rma.rmaNumber !== excludeRmaNumber)
    .reduce((sum, rma) => sum + rmaRefundCents(rma), 0);
  const fromCourtesy = context.courtesyRefunds
    .filter((refund) => refund.status !== "void")
    .reduce((sum, refund) => sum + toCents(refund.refundAmount ?? 0), 0);
  return fromRmas + fromCourtesy;
}

/**
 * Why the refunds already recorded on the order cannot be summed reliably (empty when they can):
 * a prior refund RMA line with no readable quantity or unit price, a refund RMA with no lines at
 * all, or a prior courtesy refund with no readable amount. Such lines must never count as 0.
 */
function unreconcilablePriorRefunds(context: OrderContext, excludeRmaNumber?: string): string[] {
  const reasons: string[] = [];
  for (const rma of context.rmas) {
    if (!isActiveRma(rma) || rma.rmaNumber === excludeRmaNumber || rma.type !== "refund") continue;
    const unpriced =
      rma.items.length === 0 ||
      rma.items.some(
        (item) => item.returnUnitPrice === undefined || item.returnQuantity === undefined,
      );
    if (unpriced) reasons.push(`RMA ${rma.rmaNumber} has a refund line with no readable price`);
  }
  for (const refund of context.courtesyRefunds) {
    if (refund.status !== "void" && refund.refundAmount === undefined) {
      reasons.push(`courtesy refund ${refund.courtesyRefundId} has no readable amount`);
    }
  }
  return reasons;
}

/** Order-level eligibility shared by RMAs and courtesy refunds (`SE004` / `SE026` / `SE027`). */
export function checkOrderEligibility(order: Order | undefined, findings: Findings): void {
  if (order === undefined) {
    findings.blockers.push("Newegg returned no such order for this seller.");
    return;
  }
  if (order.status === "voided") {
    findings.blockers.push("The order is voided (SE027).");
  }
  if (order.status === "unshipped" || order.status === "paymentPending") {
    findings.blockers.push(
      `The order is ${order.status}, so it has not been invoiced (SE004); only a shipped order can be returned or refunded.`,
    );
  }
  if (order.salesChannel === "replacement") {
    findings.blockers.push("The order is a replacement order (SE026).");
  }
  if (order.status === "unknown") {
    findings.warnings.push("The order status could not be determined.");
  }
}

/** Warns about RMAs and courtesy refunds already open on the order: duplicates are the main risk. */
export function warnAboutExisting(
  context: OrderContext,
  findings: Findings,
  excludeRmaNumber?: string,
): void {
  const active = context.rmas.filter(
    (rma) => isActiveRma(rma) && rma.rmaNumber !== excludeRmaNumber,
  );
  if (active.length > 0) {
    findings.warnings.push(
      `The order already has ${active.length} RMA(s) (${active
        .map((rma) => `${rma.rmaNumber}: ${rma.type} ${rma.status}`)
        .join(", ")}); check this is not a duplicate.`,
    );
  }
  const refunds = context.courtesyRefunds.filter((refund) => refund.status !== "void");
  if (refunds.length > 0) {
    findings.warnings.push(
      `The order already has ${refunds.length} courtesy refund(s) totalling ${money(
        refunds.reduce((sum, refund) => sum + toCents(refund.refundAmount ?? 0), 0),
      )}; check this is not a duplicate.`,
    );
  }
}

/** Caps a refund against what is left of the order total (`SE023` / `SE034`). */
function checkRefundBalance(
  order: Order,
  totalCents: number,
  context: OrderContext,
  findings: Findings,
  excludeRmaNumber?: string,
): void {
  const orderTotal = order.amounts.total;
  if (orderTotal === undefined) {
    findings.blockers.push(
      "The order total is unknown, so the refund cannot be capped against it (SE023).",
    );
    return;
  }
  const orderTotalCents = toCents(orderTotal);
  if (totalCents > orderTotalCents) {
    findings.blockers.push(
      `The refund of ${money(totalCents)} exceeds the order total of ${money(orderTotalCents)} (SE023).`,
    );
    return;
  }
  const unreconcilable = unreconcilablePriorRefunds(context, excludeRmaNumber);
  if (unreconcilable.length > 0) {
    findings.blockers.push(
      `Prior refunds on the order cannot be reconciled (${unreconcilable.join("; ")}), so the remaining balance is unknown (SE034).`,
    );
    return;
  }
  const prior = priorRefundCents(context, excludeRmaNumber);
  if (totalCents > orderTotalCents - prior) {
    findings.blockers.push(
      `The refund of ${money(totalCents)} exceeds the order total ${money(orderTotalCents)} minus ${money(
        prior,
      )} already refunded by other RMAs and courtesy refunds (SE034).`,
    );
  }
  const reported = order.amounts.refundAmount;
  if (reported !== undefined && toCents(reported) > prior) {
    findings.warnings.push(
      `The order reports ${money(toCents(reported))} already refunded, more than the ${money(
        prior,
      )} found in its RMAs and courtesy refunds; verify the remaining balance.`,
    );
  }
}

/**
 * Checks the lines of a submitted or edited RMA against the order and the RMAs already on it.
 * Returns the refund total in cents (0 for a replacement).
 */
export function checkRmaItems(args: {
  type: Exclude<RmaType, "unknown">;
  items: readonly RmaWriteItem[];
  context: OrderContext;
  findings: Findings;
  /** The RMA being edited, whose own lines must not count against the returnable quantity. */
  excludeRmaNumber?: string;
}): number {
  const { type, items, context, findings, excludeRmaNumber } = args;
  const order = context.order;
  if (order === undefined) return 0;

  const others = context.rmas.filter(
    (rma) => isActiveRma(rma) && rma.rmaNumber !== excludeRmaNumber,
  );
  items.forEach((line, index) => {
    const label = `Line ${index + 1} (${line.sellerPartNumber})`;
    const orderItem = order.items.find(
      (candidate) => candidate.sellerPartNumber === line.sellerPartNumber,
    );
    if (orderItem === undefined) {
      findings.blockers.push(`${label} is not an item on the order (SE001 / SE024).`);
      return;
    }
    if (orderItem.status === "cancelled") {
      findings.blockers.push(`${label} was cancelled on the order.`);
    }
    if (orderItem.orderedQty === undefined) {
      findings.warnings.push(
        `${label}: the ordered quantity is unknown, so the quantity was not capped.`,
      );
    } else {
      const alreadyReturned = others.reduce(
        (sum, rma) =>
          sum +
          rma.items
            .filter((item) => item.sellerPartNumber === line.sellerPartNumber)
            .reduce((inner, item) => inner + (item.returnQuantity ?? 0), 0),
        0,
      );
      const returnable = orderItem.orderedQty - alreadyReturned;
      if (line.returnQuantity > returnable) {
        findings.blockers.push(
          `${label}: returning ${line.returnQuantity} exceeds the returnable quantity of ${Math.max(
            returnable,
            0,
          )} (${orderItem.orderedQty} ordered, ${alreadyReturned} on other RMAs) (SE009).`,
        );
      }
    }
    if (orderItem.shippedQty !== undefined && line.returnQuantity > orderItem.shippedQty) {
      findings.warnings.push(
        `${label}: returning ${line.returnQuantity} but only ${orderItem.shippedQty} shipped.`,
      );
    }
    if (type === "refund" && line.returnUnitPrice !== undefined) {
      if (orderItem.unitPrice === undefined) {
        findings.blockers.push(
          `${label}: the item's unit price is unknown, so the refund per unit could not be capped (SE011).`,
        );
      } else if (toCents(line.returnUnitPrice) > toCents(orderItem.unitPrice)) {
        findings.blockers.push(
          `${label}: the refund per unit ${money(toCents(line.returnUnitPrice))} exceeds the unit price ${money(
            toCents(orderItem.unitPrice),
          )} (SE011).`,
        );
      }
    }
  });

  if (type !== "refund") {
    findings.warnings.push(
      "A replacement RMA ships a new unit: Newegg applies the original order's ship method and the replacement quantity must be in stock (SE013).",
    );
    return 0;
  }

  const shippingCents = items.reduce(
    (sum, line) => sum + toCents(line.refundShippingPrice ?? 0),
    0,
  );
  const orderShipping = order.amounts.shippingAmount;
  if (orderShipping !== undefined && shippingCents > toCents(orderShipping)) {
    findings.blockers.push(
      `The shipping refund of ${money(shippingCents)} exceeds the order's shipping charge of ${money(
        toCents(orderShipping),
      )} (SE012).`,
    );
  }
  const totalCents = items.reduce(
    (sum, line) =>
      sum +
      toCents(line.returnUnitPrice ?? 0) * line.returnQuantity +
      toCents(line.refundShippingPrice ?? 0),
    0,
  );
  checkRefundBalance(order, totalCents, context, findings, excludeRmaNumber);
  return totalCents;
}

/** Only an open RMA can be edited, received or rejected (`SE028`). */
export function checkRmaState(rma: Rma | undefined, findings: Findings): void {
  if (rma === undefined) {
    findings.blockers.push("Newegg returned no such RMA for this seller.");
    return;
  }
  switch (rma.status) {
    case "open":
      return;
    case "processing":
      findings.warnings.push(
        "The RMA is still processing; Newegg only accepts changes to an open RMA (SE028) and may refuse this.",
      );
      return;
    case "unknown":
      findings.warnings.push("The RMA status could not be determined.");
      return;
    default:
      findings.blockers.push(`The RMA is ${rma.status}; only an open RMA can be changed (SE028).`);
  }
}

/** Checks a courtesy refund against the order and its prior refunds. Returns the amount in cents. */
export function checkCourtesyRefund(args: {
  amount: number;
  context: OrderContext;
  findings: Findings;
}): number {
  const { amount, context, findings } = args;
  checkOrderEligibility(context.order, findings);
  const cents = toCents(amount);
  if (context.order !== undefined) {
    if (context.order.invoiceNumber === undefined) {
      findings.warnings.push(
        "The order has no invoice number; Newegg refuses an uninvoiced order (SE004).",
      );
    }
    checkRefundBalance(context.order, cents, context, findings);
  }
  warnAboutExisting(context, findings);
  const duplicate = context.courtesyRefunds.find(
    (refund) => refund.status === "open" && toCents(refund.refundAmount ?? 0) === cents,
  );
  if (duplicate !== undefined) {
    findings.warnings.push(
      `An open courtesy refund of the same amount (${duplicate.courtesyRefundId}) already exists on this order.`,
    );
  }
  findings.warnings.push("A courtesy refund does NOT refund the commission.");
  return cents;
}
