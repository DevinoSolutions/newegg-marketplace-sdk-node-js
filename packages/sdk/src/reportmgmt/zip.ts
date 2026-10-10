/**
 * Tiny read-only ZIP extractor for report packages (Daily Inventory / Daily Price `version=310`
 * zips multiple 40,000-record files into one archive; the Item Basic Info report arrives zipped
 * too). Supports stored and deflate entries - all that zip tools emit for text files - and
 * refuses encrypted, ZIP64 and oversized archives rather than guessing.
 */
import { inflateRawSync } from "node:zlib";
import { NeweggApiError } from "../errors/index.js";

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function corrupt(reason: string): NeweggApiError {
  return new NeweggApiError(`Report file is not a readable zip archive (${reason}).`, {
    retryable: false,
  });
}

/** True when the bytes start with a ZIP local-file-header signature (`PK\x03\x04`). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/** Extracts every file entry, failing if the total uncompressed size would exceed `maxTotalBytes`. */
export function extractZip(bytes: Uint8Array, maxTotalBytes: number): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw corrupt("no end-of-central-directory record");
  const entryCount = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff)
    throw corrupt("ZIP64 is unsupported");

  const entries: ZipEntry[] = [];
  let remaining = maxTotalBytes;
  let cursor = directoryOffset;
  for (let n = 0; n < entryCount; n += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw corrupt("bad central directory entry");
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = Buffer.from(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).toString(
      "utf8",
    );
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue;
    if ((flags & 1) !== 0) throw corrupt("encrypted entries are unsupported");
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw corrupt("bad local file header");
    }
    const dataStart =
      localOffset +
      30 +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    if (compressed.length !== compressedSize) throw corrupt("truncated entry");

    let data: Uint8Array;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, remaining) });
      } catch {
        throw corrupt("entry failed to inflate or exceeds the size limit");
      }
    } else {
      throw corrupt(`unsupported compression method ${method}`);
    }
    remaining -= data.length;
    if (remaining < 0) throw corrupt("archive exceeds the size limit");
    entries.push({ name, data });
  }
  return entries;
}
