/**
 * Read-only pre-send checks of a label write (contracts §23). They mirror the errors Newegg
 * documents (SL001 to SL015) against the order the SDK reads, so an obviously wrong request fails
 * before a label is bought. They only ever add to `blockers` / `warnings`.
 */
import type { Order, ShippingLabelInput } from "../types.js";
import type { ShippingLabelPlatform } from "../platform/shipping-label.js";

export interface LabelFindings {
  blockers: string[];
  warnings: string[];
}

export function newLabelFindings(): LabelFindings {
  return { blockers: [], warnings: [] };
}

/** True for the country spellings the order's ship-to address can carry. */
function isUsCountry(code: string): boolean {
  return /^(?:US|USA|UNITED STATES(?: OF AMERICA)?)$/i.test(code.trim());
}

/** Order-level eligibility shared by create and reprint. */
function checkOrderState(order: Order | undefined, findings: LabelFindings): order is Order {
  if (order === undefined) {
    findings.blockers.push("Newegg returned no such order for this seller (SL002).");
    return false;
  }
  if (order.fulfillment === "newegg") {
    findings.blockers.push(
      "The order is fulfilled by Newegg, and only orders shipped by the seller can request a label (SL004).",
    );
  }
  return true;
}

/** Checks a label PURCHASE against the order. */
export function checkCreateAgainstOrder(
  order: Order | undefined,
  input: ShippingLabelInput,
  platform: ShippingLabelPlatform,
  findings: LabelFindings,
): void {
  if (!checkOrderState(order, findings)) return;
  if (order.status !== "unshipped") {
    findings.blockers.push(
      `The order is ${order.status}; only unshipped orders can request a label (SL003).`,
    );
  }
  if (order.status === "unshipped" && order.packages.length > 0) {
    // A listed package means a label may already be bought (the ledger only knows creates made
    // through this client), so a second purchase is refused rather than merely flagged.
    findings.blockers.push(
      `The order already lists ${order.packages.length} package(s), so a label may already be bought; ` +
        "verify the order in the Seller Portal before buying another.",
    );
  }

  const ordered = new Map<string, number | undefined>();
  for (const line of order.items) {
    if (line.sellerPartNumber === undefined || line.status === "cancelled") continue;
    ordered.set(
      line.sellerPartNumber,
      (ordered.get(line.sellerPartNumber) ?? 0) + (line.orderedQty ?? 0),
    );
  }
  const requested = new Map<string, number>();
  for (const pkg of input.packages) {
    for (const item of pkg.items) {
      requested.set(
        item.sellerPartNumber,
        (requested.get(item.sellerPartNumber) ?? 0) + item.quantity,
      );
    }
  }
  for (const [sellerPartNumber, quantity] of requested) {
    if (!ordered.has(sellerPartNumber)) {
      findings.blockers.push(
        `Seller part number ${sellerPartNumber} is not an open line of this order (SL010).`,
      );
      continue;
    }
    const orderedQty = ordered.get(sellerPartNumber);
    if (orderedQty !== undefined && orderedQty > 0 && orderedQty !== quantity) {
      findings.blockers.push(
        `Seller part number ${sellerPartNumber}: ${quantity} requested but ${orderedQty} ordered; each line must be shipped for its entire quantity (SL005).`,
      );
    }
  }
  const uncovered = [...ordered.keys()].filter((spn) => !requested.has(spn));
  if (uncovered.length > 0) {
    findings.warnings.push(
      `Order line(s) not in this request stay unshipped: ${uncovered.join(", ")}.`,
    );
  }

  const shipToCountry = order.customer?.shipTo?.countryCode;
  if (platform.countryCode === "USA") {
    if (shipToCountry !== undefined && shipToCountry !== "" && !isUsCountry(shipToCountry)) {
      findings.blockers.push(
        `The order ships to ${shipToCountry}; the service only supports USA domestic transportation (SL015).`,
      );
    }
  } else {
    findings.warnings.push(
      "SL015 documents USA domestic transportation only, while the Newegg.ca service codes and country (CAN) are documented; Newegg may reject a Canadian label.",
    );
  }
  findings.warnings.push(
    "Buying a label charges the seller's Newegg account, marks the order shipped and cannot be undone through this SDK (no void endpoint is documented). Run estimate first to see the price.",
  );
  if (input.packages.some((pkg) => pkg.signatureRequired === true)) {
    findings.warnings.push("A signature requirement adds a carrier surcharge.");
  }
}

/** Checks a label REPRINT against the order. */
export function checkReprintAgainstOrder(order: Order | undefined, findings: LabelFindings): void {
  if (!checkOrderState(order, findings)) return;
  if (order.status !== "shipped" && order.status !== "partiallyShipped") {
    findings.blockers.push(
      `The order is ${order.status}; only a confirmed (shipped) order has a label to reprint.`,
    );
  }
  findings.warnings.push(
    "The reprint page does not say whether a reprint is billed; it is treated as billable, so only request it when the label is really lost.",
  );
}
