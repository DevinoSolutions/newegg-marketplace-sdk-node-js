/** Single source of truth for the SDK version (kept in sync with package.json). */
export const SDK_VERSION = "0.1.0";

/** Default `User-Agent` header value; includes the running Node.js version when available. */
export function defaultUserAgent(): string {
  const nodeVersion =
    typeof process !== "undefined" && process.versions?.node ? process.versions.node : "unknown";
  return `newegg-marketplace-sdk/${SDK_VERSION} node/${nodeVersion}`;
}
