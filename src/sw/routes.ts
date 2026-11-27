/**
 * Pure routing rules shared by the service worker and the page-side client.
 * No browser globals here, so these stay trivially unit-testable.
 */

/** Prefix for every cache this app creates. Logout clears everything with this prefix. */
export const CACHE_PREFIX = "bolt-club-hq";
export const SHELL_CACHE = `${CACHE_PREFIX}-shell-v1`;
export const API_CACHE = `${CACHE_PREFIX}-api-v2`;

/** Network-first waits this long before falling back to the cache. */
export const NETWORK_TIMEOUT_MS = 3000;

/** Navigations under these prefixes are never answered with the app shell (PLAN §11.6, S0.3). */
const NAVIGATION_DENYLIST: readonly RegExp[] = [/^\/api(\/|$)/, /^\/e\//, /^\/s\//, /^\/media\//];

/** The only GET routes cached for offline use. Authenticated routes (/me, etc.) must never be cached. */
const NETWORK_FIRST_ALLOWLIST: ReadonlySet<string> = new Set(["/api/v1/config"]);

export function isNavigationFallbackAllowed(pathname: string): boolean {
  return !NAVIGATION_DENYLIST.some((pattern) => pattern.test(pathname));
}

export function isNetworkFirstRoute(pathname: string): boolean {
  return NETWORK_FIRST_ALLOWLIST.has(pathname);
}

export function isAppCacheName(name: string): boolean {
  return name.startsWith(`${CACHE_PREFIX}-`);
}
