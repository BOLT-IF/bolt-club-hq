import type { MiddlewareHandler } from "hono";

import { GUARD_MARK } from "../core/permissions";
import type { AppEnv } from "../types";

/**
 * Any signed-in member, including pending ones: 401 without an actor, otherwise through.
 * requireGuard("member") rejects pending members, but a pending member must still be
 * able to ask who they are (the waiting screen). Carries GUARD_MARK so the route-guard
 * lint sees it.
 */
export function requireSignedIn(): MiddlewareHandler<AppEnv> {
  const handler: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!c.var.actor) return c.json({ error: "unauthenticated" }, 401);
    await next();
  };
  Object.defineProperty(handler, GUARD_MARK, { value: "member" });
  return handler;
}
