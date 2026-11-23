import type { Context, MiddlewareHandler } from "hono";

import type { CurrentMember } from "./ports";

export type GuardKind = "member" | "admin" | "owner-or-admin" | "captain-of-series";

export interface GuardOptions {
  /** Owner member id of the resource, for owner-or-admin. */
  ownerOf?: (c: Context) => string | null;
  /** Series id of the resource, for captain-of-series. */
  seriesIdOf?: (c: Context) => string | undefined;
  /** Resolves the current member from the request context. */
  actorOf?: (c: Context) => CurrentMember | null;
}

/** Marker stored on the handler so the route-guard test can see that a guard is declared. */
export const GUARD_MARK = Symbol.for("bolt-club-hq.guard");

/**
 * Permission middleware (PLAN §5.2 invariant 7 and §13 matrix). Responses:
 * 401 without an actor, 403 when the actor lacks the role, 200 otherwise.
 * Pending or inactive members never pass a member guard.
 */
export function requireGuard(kind: GuardKind, options: GuardOptions = {}): MiddlewareHandler {
  const handler: MiddlewareHandler = async (c, next) => {
    const actor = options.actorOf
      ? options.actorOf(c)
      : (c.get("actor" as never) as CurrentMember | null);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    if (actor.status !== "active") return c.json({ error: "forbidden" }, 403);

    const isAdmin = actor.role === "admin";
    const allowed = (() => {
      switch (kind) {
        case "member":
          return true;
        case "admin":
          return isAdmin;
        case "owner-or-admin":
          return isAdmin || (options.ownerOf?.(c) ?? null) === actor.id;
        case "captain-of-series": {
          if (isAdmin) return true;
          const seriesId = options.seriesIdOf?.(c);
          return seriesId !== undefined && actor.seriesIds.includes(seriesId);
        }
      }
    })();

    if (!allowed) return c.json({ error: "forbidden" }, 403);
    await next();
  };
  Object.defineProperty(handler, GUARD_MARK, { value: kind });
  return handler;
}

interface RouteLike {
  method: string;
  path: string;
  handler: unknown;
  // Hono also includes middleware entries in app.routes; those share the same handler chain.
}

/**
 * Lists `/api/v1` routes whose handler chain declares no guard. Hono stores each
 * middleware as its own route entry with method "ALL" or the verb, so a route
 * is guarded when any middleware on the same path carries GUARD_MARK.
 */
export function unguardedRoutes(routes: readonly RouteLike[]): RouteLike[] {
  const guarded = new Set(
    routes
      .filter((route) => hasGuard(route.handler))
      .map((route) => `${route.method} ${route.path}`),
  );
  return routes.filter(
    (route) =>
      route.path.startsWith("/api/v1") &&
      route.method !== "ALL" &&
      !guarded.has(`${route.method} ${route.path}`),
  );
}

function hasGuard(handler: unknown): boolean {
  return typeof handler === "function" && GUARD_MARK in handler;
}
