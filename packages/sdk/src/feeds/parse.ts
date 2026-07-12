import type { FeedRecordStatus, FeedRequestStatus, FeedResultRecord } from "../types.js";
import {
  asArray,
  asBoolean,
  asNumber,
  asString,
  asStringRecord,
  getField,
  getPath,
  isRecord,
} from "../schemas/wire.js";

const FEED_STATUSES: readonly FeedRequestStatus[] = [
  "SUBMITTED",
  "IN_PROGRESS",
  "FINISHED",
  "CANCELLED",
  "UNKNOWN",
];

/** Coerces an arbitrary status value into a known {@link FeedRequestStatus}. */
function toFeedStatus(raw: unknown): FeedRequestStatus {
  const str = asString(raw)?.trim().toUpperCase();
  const match = FEED_STATUSES.find((status) => status === str);
  return match ?? "UNKNOWN";
}

/** Extracts the `ResponseList` entries, tolerating array-of-objects or `{ ResponseInfo: [...] }`. */
function extractResponseList(json: unknown): unknown[] {
  const body = getField(json, "ResponseBody");
  const list = getField(body, "ResponseList");
  if (Array.isArray(list)) return list;
  const info = getField(list, "ResponseInfo");
  if (info !== undefined) return asArray(info);
  return asArray(list);
}

interface FeedSubmitParsed {
  isSuccess: boolean;
  requestId?: string;
  status: FeedRequestStatus;
  requestDate?: string;
}

export function parseFeedSubmitResponse(json: unknown): FeedSubmitParsed {
  const entries = extractResponseList(json);
  const first = entries[0];
  return {
    isSuccess: asBoolean(getField(json, "IsSuccess")) ?? false,
    requestId: asString(getField(first, "RequestId")),
    status: toFeedStatus(getField(first, "RequestStatus")),
    requestDate: asString(getField(first, "RequestDate")),
  };
}

interface FeedStatusParsed {
  status: FeedRequestStatus;
  requestType?: string;
  requestDate?: string;
}

/** Finds the status entry matching a request id; returns `undefined` when absent. */
export function findStatusEntry(json: unknown, requestId: string): FeedStatusParsed | undefined {
  const entries = extractResponseList(json);
  for (const entry of entries) {
    if (asString(getField(entry, "RequestId")) === requestId) {
      return {
        status: toFeedStatus(getField(entry, "RequestStatus")),
        requestType: asString(getField(entry, "RequestType")),
        requestDate: asString(getField(entry, "RequestDate")),
      };
    }
  }
  return undefined;
}

function recordStatus(messages: string[]): FeedRecordStatus {
  if (messages.some((message) => message.trim().startsWith("Error"))) return "failed";
  return messages.length > 0 ? "warning" : "unknown";
}

function parseResultRecord(raw: unknown): FeedResultRecord {
  const additionalInfo = asStringRecord(getField(raw, "AdditionalInfo"));
  const errorList = getField(raw, "ErrorList");
  const messages = asArray(getField(errorList, "ErrorDescription"))
    .map(asString)
    .filter((message): message is string => message !== undefined);
  return {
    sellerPartNumber: additionalInfo.SellerPartNumber,
    additionalInfo,
    status: recordStatus(messages),
    messages,
  };
}

interface ProcessingReportParsed {
  summary: { processed: number; succeeded: number; failed: number };
  records: FeedResultRecord[];
}

/** Parses the `ProcessingReport` from a feed-result envelope; `undefined` when not present. */
export function parseProcessingReport(json: unknown): ProcessingReportParsed | undefined {
  const report = getPath(json, ["NeweggEnvelope", "Message", "ProcessingReport"]);
  if (!isRecord(report)) return undefined;
  const summaryRaw = getField(report, "ProcessingSummary");
  return {
    summary: {
      processed: asNumber(getField(summaryRaw, "ProcessedCount")) ?? 0,
      succeeded: asNumber(getField(summaryRaw, "SuccessCount")) ?? 0,
      failed: asNumber(getField(summaryRaw, "WithErrorCount")) ?? 0,
    },
    records: asArray(getField(report, "Result")).map(parseResultRecord),
  };
}
