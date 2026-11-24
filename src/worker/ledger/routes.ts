import { inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { event, guest } from "../../../db/schema";
import { contextMiddleware } from "../core/context";
import { requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
import adminRoutes from "./admin-routes";
import { createLedgerService } from "./service";

function actorId(c: Context<AppEnv>): string {
  const actor = c.var.actor;
  if (!actor) throw new Error("ledger: guard let a request through without an actor");
  return actor.id;
}

/**
 * A member's own ledger (S5.1 "me-read"). Every query is scoped to the actor. Admin
 * balances, payments and adjustments are S5.4, claims S5.5.
 */
export default new Hono<AppEnv>()
  // Scoped, not "*": see DECISIONS 2026-11-24 (W2 contract 2). "/me/ledger/*" also matches
  // "/me/ledger", so a second `.use("/me/ledger", …)` would open the database twice.
  .use("/me/ledger/*", contextMiddleware())
  // allowInactive: an exited member keeps access to Money (PLAN §6.7).
  .get("/me/ledger", requireGuard("member", { allowInactive: true }), async (c) => {
    const me = actorId(c);
    // Own ledger only. A member id that is not the caller's is refused, admins included.
    const asked = c.req.query("memberId");
    if (asked !== undefined && asked !== me) return c.json({ error: "forbidden" }, 403);

    const result = await createLedgerService({ db: c.var.db, clock: c.var.clock }).itemize(me);

    const eventIds = [
      ...new Set(result.items.flatMap((i) => (i.entry.eventId ? [i.entry.eventId] : []))),
    ];
    const guestIds = [
      ...new Set(result.items.flatMap((i) => (i.entry.guestId ? [i.entry.guestId] : []))),
    ];
    const events =
      eventIds.length === 0
        ? []
        : await c.var.db
            .select({ id: event.id, title: event.title, startsAt: event.startsAt })
            .from(event)
            .where(inArray(event.id, eventIds));
    const guests =
      guestIds.length === 0
        ? []
        : await c.var.db
            .select({ id: guest.id, name: guest.name })
            .from(guest)
            .where(inArray(guest.id, guestIds));
    const eventById = new Map(events.map((e) => [e.id, e]));
    const guestById = new Map(guests.map((g) => [g.id, g]));

    return c.json({
      balanceSek: result.balanceSek,
      owedSek: result.owedSek,
      creditSek: result.creditSek,
      items: result.items.map(({ entry, status, allocatedSek, outstandingSek }) => ({
        id: entry.id,
        kind: entry.kind,
        reason: entry.reason,
        amountSek: entry.amountSek,
        status,
        allocatedSek,
        outstandingSek,
        note: entry.note,
        createdAt: new Date(entry.createdAt).toISOString(),
        reversesEntryId: entry.reversesEntryId,
        passId: entry.passId,
        eventId: entry.eventId,
        eventTitle: (entry.eventId && eventById.get(entry.eventId)?.title) || null,
        eventStartsAt:
          (entry.eventId && eventById.get(entry.eventId)?.startsAt.toISOString()) || null,
        guestId: entry.guestId,
        guestName: (entry.guestId && guestById.get(entry.guestId)?.name) || null,
      })),
    });
  })
  .route("/", adminRoutes);
