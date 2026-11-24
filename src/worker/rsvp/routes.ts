import { Hono, type Context, type MiddlewareHandler } from "hono";

import { contextMiddleware } from "../core/context";
import { idempotencyKeyMiddleware } from "../core/idempotency";
import { requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
import { rsvpDeps } from "./deps";
import {
  DEFAULT_GUEST_NAME,
  MAX_GUEST_NAME,
  cancelRsvp,
  getRsvp,
  putRsvp,
  type RsvpResult,
} from "./model";

const PATH = "/events/:id/rsvp";

/** The idempotency middleware needs the per-request db, so it is built per request (W2 contract). */
function idempotent(route: string): MiddlewareHandler<AppEnv> {
  return (c, next) =>
    idempotencyKeyMiddleware({
      db: c.var.db,
      route,
      // The guard runs first, so an actor is always present here.
      actorOf: (ctx) => (ctx.get("actor" as never) as { id: string }).id,
    })(c, next);
}

/** `{ guests?: string[] }`, nothing else. Blank names become "Guest" (A4). Null when malformed. */
export function parseGuests(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "guests")) return null;
  const raw = (body as { guests?: unknown }).guests;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const name = item.trim();
    if (name.length > MAX_GUEST_NAME) return null;
    names.push(name === "" ? DEFAULT_GUEST_NAME : name);
  }
  return names;
}

/** The member guard has already run, so an actor is present. */
function actorId(c: Context<AppEnv>): string {
  const actor = c.var.actor;
  if (!actor) throw new Error("rsvp: route reached without an actor");
  return actor.id;
}

function reply(c: Context<AppEnv>, result: RsvpResult) {
  if (result.ok) return c.json({ rsvp: result.rsvp });
  if (result.error === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.error === "guest_limit") return c.json({ error: "guest_limit", max: result.max }, 400);
  return c.json({ error: "rsvp_closed" }, 409);
}

// Scoped to this area's path only: every area is mounted at /api/v1 (DECISIONS W2 contract 2).
export default new Hono<AppEnv>()
  .use(PATH, contextMiddleware())
  .get(PATH, requireGuard("member"), async (c) => {
    const result = await getRsvp(c.var.db, c.req.param("id"), actorId(c));
    return reply(c, result);
  })
  .put(PATH, requireGuard("member"), idempotent("PUT /api/v1/events/:id/rsvp"), async (c) => {
    const guests = parseGuests(await c.req.json().catch(() => ({})));
    if (!guests) return c.json({ error: "invalid_body" }, 400);
    const result = await putRsvp(c.var.db, c.var.clock, rsvpDeps().prepaid(c.var.db), {
      eventId: c.req.param("id"),
      memberId: actorId(c),
      guests,
    });
    return reply(c, result);
  })
  .delete(PATH, requireGuard("member"), idempotent("DELETE /api/v1/events/:id/rsvp"), async (c) => {
    const result = await cancelRsvp(c.var.db, c.var.clock, {
      eventId: c.req.param("id"),
      memberId: actorId(c),
    });
    return reply(c, result);
  });
