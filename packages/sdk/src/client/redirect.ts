/**
 * Manual redirect handling for READ requests. The SDK sends credentials as plain headers
 * (`Authorization`, `SecretKey`), and `fetch` only strips `Authorization`, `Cookie` and
 * `Proxy-Authorization` when a redirect crosses origins, so `SecretKey` would reach a foreign host.
 * Reads therefore use `redirect: "manual"` and follow a redirect only to the SAME origin as the
 * original request, over a hop budget, never from https to http.
 */

/** Redirect responses a read follows; every other 3xx is handed back as an ordinary response. */
const FOLLOWED_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Maximum redirects followed for one request; the next one is refused. */
export const MAX_READ_REDIRECTS = 5;

export const REDIRECT_REFUSED_CROSS_ORIGIN = "REDIRECT_REFUSED_CROSS_ORIGIN";
export const REDIRECT_REFUSED_DOWNGRADE = "REDIRECT_REFUSED_DOWNGRADE";
export const REDIRECT_REFUSED_TOO_MANY = "REDIRECT_REFUSED_TOO_MANY";
export const REDIRECT_REFUSED_INVALID_LOCATION = "REDIRECT_REFUSED_INVALID_LOCATION";

export type RedirectRefusal =
  | typeof REDIRECT_REFUSED_CROSS_ORIGIN
  | typeof REDIRECT_REFUSED_DOWNGRADE
  | typeof REDIRECT_REFUSED_TOO_MANY
  | typeof REDIRECT_REFUSED_INVALID_LOCATION;

/** True when a response is a redirect the read path should follow (it carries a `Location`). */
export function isFollowedRedirect(status: number, location: string | null): boolean {
  return FOLLOWED_STATUSES.has(status) && location !== null && location !== "";
}

/**
 * Resolves a `Location` header against the URL that produced it (so relative references work) and
 * checks it against the ORIGINAL request URL. Returns the next URL, or the reason it is refused.
 * Same origin means identical scheme, host and port, which also rules out any downgrade except the
 * explicit https -> http check done first so it gets its own reason.
 */
export function resolveRedirectTarget(
  original: URL,
  current: URL,
  location: string,
): URL | RedirectRefusal {
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    return REDIRECT_REFUSED_INVALID_LOCATION;
  }
  if (next.username !== "" || next.password !== "") return REDIRECT_REFUSED_INVALID_LOCATION;
  if (original.protocol === "https:" && next.protocol !== "https:") {
    return REDIRECT_REFUSED_DOWNGRADE;
  }
  if (next.origin !== original.origin) return REDIRECT_REFUSED_CROSS_ORIGIN;
  return next;
}

/**
 * The method and body for the follow-up request, per the fetch standard: a 303 becomes a GET (HEAD
 * stays HEAD), a 301/302 turns only a POST into a GET, and 307/308 never change anything. A PUT read
 * such as order-info therefore keeps its method and body across 301/302/307/308.
 */
export function redirectedMethod(
  status: number,
  method: string,
): { method: string; dropBody: boolean } {
  const upper = method.toUpperCase();
  if (status === 303 && upper !== "GET" && upper !== "HEAD")
    return { method: "GET", dropBody: true };
  if ((status === 301 || status === 302) && upper === "POST")
    return { method: "GET", dropBody: true };
  return { method, dropBody: false };
}
