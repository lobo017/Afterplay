// The site is always served as http://127.0.0.1:<port>. `localhost` (and `[::1]`) reach the
// same server but are different browser origins, each with its own IndexedDB game library,
// so requests that arrive under those names are redirected to the one canonical origin.

export const CANONICAL_HOST = '127.0.0.1';

const OTHER_LOOPBACK_NAMES = new Set(['localhost', '[::1]', '::1']);

/** The host name of a Host header value ("localhost:4173" → "localhost", "[::1]:4173" → "[::1]"). */
export function hostNameOf(hostHeader) {
  const host = String(hostHeader ?? '').trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * Where a request should be redirected to reach the canonical origin, or null when it is
 * already there. The path and query are kept (the browser keeps the #fragment itself).
 * @param {string | undefined} hostHeader
 * @param {string | undefined} requestUrl  the request target, e.g. "/?mode=games"
 * @param {number} port
 */
export function canonicalRedirect(hostHeader, requestUrl, port) {
  const name = hostNameOf(hostHeader);
  if (!OTHER_LOOPBACK_NAMES.has(name)) return null;
  const target = String(requestUrl ?? '/');
  const pathAndQuery = target.startsWith('/') ? target : '/';
  return `http://${CANONICAL_HOST}:${port}${pathAndQuery}`;
}
