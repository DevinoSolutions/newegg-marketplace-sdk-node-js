/** Shipping label types (contracts §23). Re-exported from `../types.ts`. */

import type { NeweggMarketplace, RequestOptions } from "./common.js";
import type { RmaCurrency } from "./rma.js";
import type { RateLimitInfo } from "./runtime.js";

/**
 * An earlier label create for the same order that blocks a new one (T-6212): dispatched with an
 * unknown outcome (`submitting`) or confirmed bought (`submitted`). Kept per (marketplace, order)
 * in the client's `OperationStore` for 24 hours.
 */
export interface LabelCreateAttempt {
  state: "submitting" | "submitted";
  /** Pass this as `acknowledgePriorAttemptId` once the order is verified to hold no label. */
  attemptId: string;
  /** When the attempt was last recorded (ISO 8601). */
  atIso: string;
}

/** Options of {@link ShippingLabelsApi.previewCreate} / `create`. */
export interface ShippingLabelCreateOptions extends RequestOptions {
  /**
   * The `attemptId` of the prior create attempt, passed back after the caller verified that the
   * order holds no label. It clears ONLY that attempt, and only while the order lists no package;
   * a newer attempt blocks again.
   */
  acknowledgePriorAttemptId?: string;
}

// ----------------------------------------------------------------------------
// shipping labels (contracts §23)
// ----------------------------------------------------------------------------
/** Ship-from address and contact of a label request (the rate is computed from it). */
export interface ShippingLabelShipFrom {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  address1: string;
  address2?: string;
  city: string;
  /** Two-letter state or province code, e.g. `CA`, `ON`. */
  stateCode: string;
  zipCode: string;
  /** ISO alpha-3; defaults to the marketplace's (`USA` on Newegg.com / Business, `CAN` on Newegg.ca). */
  countryCode?: string;
}

/** One order line shipped in a package. The line's entire ordered quantity must be shipped (SL005). */
export interface ShippingLabelItem {
  sellerPartNumber: string;
  quantity: number;
}

/** One package of a label request. Units are the pages' defaults: pounds and inches (ASSUMPTION). */
export interface ShippingLabelPackage {
  weightLb: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  /** Require the recipient's signature on delivery (`SignatureOptions: Regular`; extra charge). */
  signatureRequired?: boolean;
  items: ShippingLabelItem[];
}

/** Input to {@link ShippingLabelsApi.estimate} / `previewCreate` / `create`. */
export interface ShippingLabelInput {
  orderNumber: string | number;
  /**
   * UPS service code. Newegg.com / Business: 101 Ground, 102 3 Day Select, 103 2nd Day Air,
   * 104 Next Day Air Saver, 105 Next Day Air. Newegg.ca: 111 Standard, 112 Express, 113 Expedited,
   * 114 Express Saver. Omit to let Newegg map the service the customer bought.
   */
  serviceCode?: number;
  shipFrom: ShippingLabelShipFrom;
  packages: ShippingLabelPackage[];
}

/** Which label write a preview or an indeterminate error refers to. */
export type ShippingLabelWriteOperation = "shippingLabels.create" | "shippingLabels.reprint";

/**
 * The read-only plan for a label write: the validated, normalized input and every blocker and
 * warning found by reading the order. A write is allowed only when `blockers` is empty; `create` /
 * `reprint` re-run the same checks and throw {@link NeweggValidationError} otherwise. No Newegg
 * mutation happens while building it.
 */
export interface ShippingLabelPreview<N> {
  marketplace: NeweggMarketplace;
  operation: ShippingLabelWriteOperation;
  /** The exact input a later write would send. Round-trips straight into the write method. */
  normalized: N;
  /** Currency of the amounts Newegg quotes (assumed from the marketplace). */
  currency: RmaCurrency;
  orderNumber: string;
  /** Reasons the write MUST NOT be sent. */
  blockers: string[];
  /** Things worth a human look; they do not stop the write. */
  warnings: string[];
  correlationId: string;
  /** Set by `previewCreate` when an earlier create for this order blocks (or was acknowledged for) this one. */
  priorAttempt?: LabelCreateAttempt;
}

/** The carrier charge Newegg quotes (estimate) or bills (create) for one package. */
export interface ShippingLabelRate {
  shipWeight?: number;
  arriveBy?: { raw: string; iso?: string };
  shippingAmount?: number;
  /** The signature surcharge (0 when none). */
  signatureAmount?: number;
  total?: number;
}

/** One package of an estimate answer. */
export interface ShippingLabelEstimatePackage {
  succeeded: boolean;
  /** Newegg's `ErrorMessage` for a package it could not rate. */
  errorMessage?: string;
  weightLb?: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
  signatureRequired: boolean;
  rate?: ShippingLabelRate;
}

/** Result of {@link ShippingLabelsApi.estimate}: a quote, nothing is bought or shipped. */
export interface ShippingLabelEstimate {
  marketplace: NeweggMarketplace;
  orderNumber: string;
  estimatedDate?: { raw: string; iso?: string };
  currency: RmaCurrency;
  packages: ShippingLabelEstimatePackage[];
  /** Sum of the packages' estimated totals that Newegg returned. */
  estimatedTotal: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** One purchased (or reprinted) package label. */
export interface ShippingLabelPackageResult {
  succeeded: boolean;
  /** Newegg's `ErrorMessage` for a package that failed. */
  errorMessage?: string;
  trackingNumber?: string;
  signatureRequired: boolean;
  /** Download link of the label PDF. A bearer link: treat it as sensitive. */
  labelUrl?: string;
  /** Download link of the packing list (the pages name the field `PackageListUrl` and `PackingListUrl`). */
  packingListUrl?: string;
  rate?: ShippingLabelRate;
  items: ShippingLabelItem[];
}

/** Result of {@link ShippingLabelsApi.create}. At least one package succeeded. */
export interface ShippingLabelResult {
  marketplace: NeweggMarketplace;
  operation: "shippingLabels.create";
  orderNumber: string;
  shipDate?: { raw: string; iso?: string };
  currency: RmaCurrency;
  packages: ShippingLabelPackageResult[];
  succeededCount: number;
  failedCount: number;
  /** Sum of the successful packages' billed totals. */
  totalCharged: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Result of {@link ShippingLabelsApi.reprint}. */
export interface ShippingLabelReprintResult {
  marketplace: NeweggMarketplace;
  operation: "shippingLabels.reprint";
  orderNumber: string;
  /** `OrderStatus` Newegg reports (`Shipped` / `PartiallyShipped`). */
  orderStatus?: string;
  packages: ShippingLabelPackageResult[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/**
 * Newegg Shipping Label Service (contracts §23; the UPS "Newegg Partnered Carrier"). `estimate` is
 * the only method that is not a write: the page calls it "for estimation only". `create` BUYS a
 * UPS label, bills the seller's Newegg account and ships the order; `reprint` re-issues the label
 * of a confirmed order and is treated as billable. Both writes are NON-idempotent POSTs, each has a
 * read-only `preview*` twin (it reads the order and reports blockers), and an ambiguous failure
 * throws {@link IndeterminateOrderWriteError} and is never resent (ADR 0004).
 */
export interface ShippingLabelsApi {
  /** Shipping Label Estimate Request (1,000 req/hr): a per-package quote. */
  estimate(input: ShippingLabelInput, options?: RequestOptions): Promise<ShippingLabelEstimate>;
  /** Read-only plan for {@link ShippingLabelsApi.create}; nothing is bought. */
  previewCreate(
    input: ShippingLabelInput,
    options?: ShippingLabelCreateOptions,
  ): Promise<ShippingLabelPreview<ShippingLabelInput>>;
  /**
   * WRITE: Shipping Label Request (1,000 req/hr). Buys the label(s) and ships the order. Refuses
   * with `LabelCreateGuardError` (nothing sent) while an earlier create for the same order was
   * dispatched with an unknown outcome or succeeded; see {@link ShippingLabelCreateOptions}.
   */
  create(
    input: ShippingLabelInput,
    options?: ShippingLabelCreateOptions,
  ): Promise<ShippingLabelResult>;
  /** Read-only plan for {@link ShippingLabelsApi.reprint}; nothing is requested. */
  previewReprint(
    orderNumber: string | number,
    options?: RequestOptions,
  ): Promise<ShippingLabelPreview<ShippingLabelReprintInput>>;
  /** WRITE: Shipping Label Reprint Request (1,000 req/hr). Treated as billable. */
  reprint(
    orderNumber: string | number,
    options?: RequestOptions,
  ): Promise<ShippingLabelReprintResult>;
}

/** Normalized input of a reprint: the order number as a digit string. */
export interface ShippingLabelReprintInput {
  orderNumber: string;
}
