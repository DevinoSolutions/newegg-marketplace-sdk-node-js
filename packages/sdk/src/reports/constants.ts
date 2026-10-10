/** Settlement report constants (contracts §17.2 / §17.3). */
import type { SettlementTransactionType } from "../types.js";

export const SETTLEMENT_SUMMARY_OPERATION_TYPE = "SettlementSummaryReportRequest";
export const SETTLEMENT_SUMMARY_REQUEST_TYPE = "SETTLEMENT_SUMMARY_REPORT";
export const SETTLEMENT_TRANSACTION_OPERATION_TYPE = "SettlementTransactionReportRequest";
export const SETTLEMENT_TRANSACTION_REQUEST_TYPE = "SETTLEMENT_TRANSACTION_REPORT";

/**
 * Settlement-summary response `version` requested by default: the newest documented field set
 * (306-313, each adding fields; 313 adds the sales-tax pair). ASSUMPTION: accepted everywhere.
 */
export const SETTLEMENT_SUMMARY_DEFAULT_VERSION = "313";

/** Default cap on result pages (100 rows each) gathered by `waitFor*`. */
export const REPORT_DEFAULT_MAX_PAGES = 50;
/** Default cap on parsed file rows kept by `download` / `waitFor*` on file reports. */
export const REPORT_FILE_DEFAULT_MAX_ROWS = 50_000;
/** Hard cap on a downloaded report file (compressed), bytes. */
export const REPORT_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** Hard cap on the total uncompressed size of a zip package, bytes. */
export const REPORT_FILE_MAX_UNZIPPED_BYTES = 256 * 1024 * 1024;
/** Budget for connect + login + transfer of one report file, ms. */
export const REPORT_FILE_DOWNLOAD_TIMEOUT_MS = 120_000;

/** `TransactionType` wire codes (§17.3). `0` = all. */
export const SETTLEMENT_TRANSACTION_TYPE_CODES: Record<SettlementTransactionType, number> = {
  all: 0,
  order: 1,
  refund: 2,
  creditRequest: 3,
  chargeback: 4,
  monthlyFee: 5,
  fulfillByNeweggFee: 6,
  multiChannelFee: 7,
  rmaProcessingFee: 8,
  taxAndDuty: 9,
  storageFee: 10,
  rmaBuyoutFee: 11,
  adjustmentFee: 12,
  monthlyFeeByCreditCard: 13,
  sbnInboundFee: 14,
  merchandisingFee: 15,
  premierFee: 16,
  shippingLabelFee: 17,
  returnAndDisposalFee: 18,
  relabelingFee: 19,
  recyclingFeeOrEhf: 20,
  returnShippingLabelFee: 21,
  serviceFeeTax: 22,
  printShippingLabelService: 23,
  reservedBalance: 24,
  previousReservedBalance: 25,
  commissionIncentiveRefund: 26,
  unsoldListingFee: 27,
  orderProcessingFee: 28,
  salesTaxAndFees: 29,
  sbnInboundIncomplianceCharges: 30,
  sponsoredAds: 31,
  itemOverageFee: 32,
};
