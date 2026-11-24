import type { MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Origin check for state-changing requests (PLAN §11.5). There are no auth cookies, so
 * CSRF is not the risk, but a browser request from another site must still be refused.
 * A request without an Origin header (a bearer-only API client) passes; one whose Origin
 * is not this site's, including "null", gets 403.
 */
export function originGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header("Origin");
    if (origin === undefined) return next();
    let allowed = false;
    try {
      allowed = new URL(origin).origin === new URL(c.req.url).origin;
    } catch {
      allowed = false;
    }
    return allowed ? next() : c.json({ error: "bad_origin" }, 403);
  };
}
