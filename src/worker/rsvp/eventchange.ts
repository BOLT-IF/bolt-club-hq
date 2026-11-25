import { and, asc, eq, inArray, notExists } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { alias } from "drizzle-orm/pg-core";

import { event, guest, ledgerEntry, rsvp } from "../../../db/schema";
import { audit } from "../core/audit";
import type { Clock } from "../core/clock";
import { contextMiddleware } from "../core/context";
import type { Db, Tx } from "../core/db/client";
import { publishEvent } from "../core/events";
import { idempotencyKeyMiddleware } from "../core/idempotency";
import { requireGuard } from "../core/permissions";
import type { CurrentMember, PublishOgPort } from "../core/ports";
import { eventsDeps } from "../events/deps";
import { canManageEvent, eventOgKey, ogSnapshot } from "../events/rules";
import { createLedgerService } from "../ledger/service";
import { createNotifyPort } from "../notifications/notify";
import type { AppEnv } from "../types";
import { closeDueEvents } from "./close";

const CANCEL_PATH = "/events/:id/cancel";
const DETAILS_PATH = "/events/:id/details";

export const FREE_CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ["requested", "confirmed", "waitlisted", "offered"] as const;

export function isInMaterialChangeWindow(e: { materialChangeAt: Date | null }, now: Date): boolean {
  return (
    e.materialChangeAt !== null &&
    now.getTime() < e.materialChangeAt.getTime() + FREE_CANCEL_WINDOW_MS
  );
}

/**
 * Reverses any unreversed charges for a member (or a single guest) on an event.
 * Used by both event cancellation and 24h material-change free cancels.
 */
export async function reverseMemberEventCharges(
  tx: Tx,
  clock: Clock,
  input: {
    eventId: string;
    memberId: string;
    guestId?: string;
    keyPrefix: string;
  },
): Promise<number> {
  const reversal = alias(ledgerEntry, "reversal");
  const unreversed = await tx
    .select({ id: ledgerEntry.id })
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.eventId, input.eventId),
        eq(ledgerEntry.memberId, input.memberId),
        eq(ledgerEntry.kind, "charge"),
        input.guestId ? eq(ledgerEntry.guestId, input.guestId) : undefined,
        notExists(
          tx
            .select({ id: reversal.id })
            .from(reversal)
            .where(eq(reversal.reversesEntryId, ledgerEntry.id)),
        ),
      ),
    )
    .orderBy(asc(ledgerEntry.createdAt), asc(ledgerEntry.id));

  if (unreversed.length === 0) return 0;

  const ledger = createLedgerService({ db: tx, clock });
  for (const row of unreversed) {
    await ledger.reverse({
      entryId: row.id,
      idempotencyKey: `${input.keyPrefix}:${row.id}`,
    });
  }
  return unreversed.length;
}

export type EventChangeResult =
  | { readonly ok: true; readonly event: typeof event.$inferSelect }
  | {
      readonly ok: false;
      readonly error:
        | "not_found"
        | "forbidden"
        | "invalid_body"
        | "event_cancelled"
        | "event_ended"
        | "event_read_only"
        | "event_closed";
    };

async function refreshOg(
  publishOg: PublishOgPort,
  row: typeof event.$inferSelect,
  onOgError?: (error: unknown) => void,
): Promise<void> {
  try {
    await publishOg.publishOg({ key: eventOgKey(row.shareSlug), html: ogSnapshot(row) });
  } catch (error) {
    onOgError?.(error);
  }
}

export async function cancelEvent(
  db: Db,
  clock: Clock,
  input: {
    eventId: string;
    actor: CurrentMember;
    publishOg: PublishOgPort;
    onOgError?: (error: unknown) => void;
  },
): Promise<EventChangeResult> {
  const now = clock.now();

  const result = await db.transaction(async (tx): Promise<EventChangeResult> => {
    const [e] = await tx.select().from(event).where(eq(event.id, input.eventId)).for("update");
    if (!e) return { ok: false, error: "not_found" };
    if (!canManageEvent(input.actor, e)) return { ok: false, error: "forbidden" };
    if (e.status === "cancelled") return { ok: false, error: "event_cancelled" };
    if (e.status === "completed" || e.endsAt <= now) return { ok: false, error: "event_ended" };

    const [updated] = await tx
      .update(event)
      .set({ status: "cancelled" })
      .where(eq(event.id, e.id))
      .returning();
    if (!updated) throw new Error("cancelEvent: update returned no row");

    const activeRsvps = await tx
      .select({ id: rsvp.id, memberId: rsvp.memberId })
      .from(rsvp)
      .where(and(eq(rsvp.eventId, e.id), inArray(rsvp.status, [...ACTIVE_STATUSES])));

    const rsvpIds = activeRsvps.map((r) => r.id);
    if (rsvpIds.length > 0) {
      await tx
        .update(rsvp)
        .set({ status: "cancelled", cancelledAt: now })
        .where(inArray(rsvp.id, rsvpIds));

      await tx
        .update(guest)
        .set({ status: "cancelled" })
        .where(and(inArray(guest.rsvpId, rsvpIds), inArray(guest.status, [...ACTIVE_STATUSES])));
    }

    const reversal = alias(ledgerEntry, "reversal");
    const unreversed = await tx
      .select({ id: ledgerEntry.id, memberId: ledgerEntry.memberId })
      .from(ledgerEntry)
      .where(
        and(
          eq(ledgerEntry.eventId, e.id),
          eq(ledgerEntry.kind, "charge"),
          notExists(
            tx
              .select({ id: reversal.id })
              .from(reversal)
              .where(eq(reversal.reversesEntryId, ledgerEntry.id)),
          ),
        ),
      )
      .orderBy(asc(ledgerEntry.createdAt), asc(ledgerEntry.id));

    const ledger = createLedgerService({ db: tx, clock });
    for (const row of unreversed) {
      await ledger.reverse({
        entryId: row.id,
        idempotencyKey: `event-cancel:${row.id}`,
      });
    }

    const notifyMemberIds = new Set<string>([
      ...activeRsvps.map((r) => r.memberId),
      ...unreversed.map((u) => u.memberId),
    ]);
    const notify = createNotifyPort({ db: tx, clock });
    for (const memberId of notifyMemberIds) {
      await notify.notify({
        memberId,
        category: "rsvp_status",
        title: "Event cancelled",
        body:
          unreversed.length > 0
            ? `${updated.title} has been cancelled. Any charges have been reversed.`
            : `${updated.title} has been cancelled.`,
        link: `/events/${updated.shareSlug}`,
        idempotencyKey: `event-cancel-notify:${updated.id}:${memberId}`,
      });
    }

    await audit(
      tx,
      clock,
      {
        actorId: input.actor.id,
        action: "event.cancel",
        entity: "event",
        entityId: updated.id,
        before: { status: e.status },
        after: { status: "cancelled", reversedCount: unreversed.length },
      },
      crypto.randomUUID(),
    );

    await publishEvent(tx, clock, {
      id: `evo_cancel_${updated.id}`,
      type: "event_cancelled",
      payload: { eventId: updated.id },
    });

    return { ok: true, event: updated };
  });

  if (result.ok) {
    await refreshOg(input.publishOg, result.event, input.onOgError);
  }
  return result;
}

export interface EventDetailsPatch {
  title?: string;
  location?: string | null;
  startsAt?: Date;
  endsAt?: Date;
  rsvpCloseAt?: Date;
  adhocFee?: number;
}

const ALLOWED_PATCH_KEYS = new Set([
  "title",
  "location",
  "startsAt",
  "endsAt",
  "rsvpCloseAt",
  "adhocFee",
]);

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseDetailsPatch(body: unknown): EventDetailsPatch | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) return null;

  const patch: EventDetailsPatch = {};
  for (const [key, value] of entries) {
    if (!ALLOWED_PATCH_KEYS.has(key)) return null;
    if (key === "title") {
      if (typeof value !== "string" || value.trim() === "" || value.trim().length > 120) {
        return null;
      }
      patch.title = value.trim();
    } else if (key === "location") {
      if (value !== null && typeof value !== "string") return null;
      const trimmed = value === null ? "" : value.trim();
      if (trimmed.length > 200) return null;
      patch.location = trimmed === "" ? null : trimmed;
    } else if (key === "startsAt") {
      const d = parseIsoDate(value);
      if (!d) return null;
      patch.startsAt = d;
    } else if (key === "endsAt") {
      const d = parseIsoDate(value);
      if (!d) return null;
      patch.endsAt = d;
    } else if (key === "rsvpCloseAt") {
      const d = parseIsoDate(value);
      if (!d) return null;
      patch.rsvpCloseAt = d;
    } else if (key === "adhocFee") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
      patch.adhocFee = value;
    }
  }
  return patch;
}

export async function updateEventDetails(
  db: Db,
  clock: Clock,
  input: {
    eventId: string;
    actor: CurrentMember;
    patch: EventDetailsPatch;
    publishOg: PublishOgPort;
    onOgError?: (error: unknown) => void;
  },
): Promise<EventChangeResult> {
  await closeDueEvents(db, clock, { targetEventId: input.eventId });
  const now = clock.now();

  const result = await db.transaction(async (tx): Promise<EventChangeResult> => {
    const [e] = await tx.select().from(event).where(eq(event.id, input.eventId)).for("update");
    if (!e) return { ok: false, error: "not_found" };
    if (!canManageEvent(input.actor, e)) return { ok: false, error: "forbidden" };
    if (e.status === "cancelled") return { ok: false, error: "event_cancelled" };
    if (e.status === "completed" || e.endsAt <= now) return { ok: false, error: "event_read_only" };

    const { patch } = input;
    if (patch.adhocFee !== undefined) {
      if (e.status === "closed" || e.closedProcessedAt !== null) {
        return { ok: false, error: "event_closed" };
      }
      if (e.kind === "member_oneoff" && patch.adhocFee !== 0) {
        return { ok: false, error: "forbidden" };
      }
      if (input.actor.role !== "admin" && patch.adhocFee !== e.adhocFee) {
        return { ok: false, error: "forbidden" };
      }
    }

    const nextStartsAt = patch.startsAt ?? e.startsAt;
    const nextEndsAt = patch.endsAt ?? e.endsAt;
    const nextRsvpCloseAt = patch.rsvpCloseAt ?? e.rsvpCloseAt;
    if (nextEndsAt <= nextStartsAt) return { ok: false, error: "invalid_body" };
    if (e.status === "scheduled" && nextRsvpCloseAt > nextStartsAt) {
      return { ok: false, error: "invalid_body" };
    }

    const timeChanged =
      (patch.startsAt !== undefined && patch.startsAt.getTime() !== e.startsAt.getTime()) ||
      (patch.endsAt !== undefined && patch.endsAt.getTime() !== e.endsAt.getTime());
    const locationChanged = patch.location !== undefined && patch.location !== e.location;
    const isMaterialAfterClose = e.status === "closed" && (timeChanged || locationChanged);

    const [updated] = await tx
      .update(event)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.location !== undefined ? { location: patch.location } : {}),
        ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
        ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt } : {}),
        ...(patch.rsvpCloseAt !== undefined ? { rsvpCloseAt: patch.rsvpCloseAt } : {}),
        ...(patch.adhocFee !== undefined ? { adhocFee: patch.adhocFee } : {}),
        ...(isMaterialAfterClose ? { materialChangeAt: now } : {}),
      })
      .where(eq(event.id, e.id))
      .returning();
    if (!updated) throw new Error("updateEventDetails: update returned no row");

    if (isMaterialAfterClose) {
      const activeRsvps = await tx
        .select({ memberId: rsvp.memberId })
        .from(rsvp)
        .where(and(eq(rsvp.eventId, e.id), inArray(rsvp.status, [...ACTIVE_STATUSES])));

      const notify = createNotifyPort({ db: tx, clock });
      for (const memberId of new Set(activeRsvps.map((r) => r.memberId))) {
        await notify.notify({
          memberId,
          category: "rsvp_status",
          title: "Event updated",
          body: `${updated.title} details changed (date, time, or location). You can cancel for free within 24 hours.`,
          link: `/events/${updated.shareSlug}`,
          idempotencyKey: `event-change-notify:${updated.id}:${String(now.getTime())}:${memberId}`,
        });
      }

      await publishEvent(tx, clock, {
        id: `evo_change_${updated.id}_${String(now.getTime())}`,
        type: "event_material_change",
        payload: { eventId: updated.id, materialChangeAt: now.toISOString() },
      });
    }

    await audit(
      tx,
      clock,
      {
        actorId: input.actor.id,
        action: isMaterialAfterClose ? "event.material_change" : "event.update",
        entity: "event",
        entityId: updated.id,
        before: {
          title: e.title,
          location: e.location,
          startsAt: e.startsAt.toISOString(),
          endsAt: e.endsAt.toISOString(),
          rsvpCloseAt: e.rsvpCloseAt.toISOString(),
          adhocFee: e.adhocFee,
        },
        after: {
          title: updated.title,
          location: updated.location,
          startsAt: updated.startsAt.toISOString(),
          endsAt: updated.endsAt.toISOString(),
          rsvpCloseAt: updated.rsvpCloseAt.toISOString(),
          adhocFee: updated.adhocFee,
          materialChangeAt: updated.materialChangeAt?.toISOString() ?? null,
        },
      },
      crypto.randomUUID(),
    );

    return { ok: true, event: updated };
  });

  if (result.ok) {
    await refreshOg(input.publishOg, result.event, input.onOgError);
  }
  return result;
}

function idempotent(route: string): MiddlewareHandler<AppEnv> {
  return (c, next) =>
    idempotencyKeyMiddleware({
      db: c.var.db,
      route,
      actorOf: (ctx) => (ctx.get("actor" as never) as { id: string }).id,
    })(c, next);
}

function actorOf(c: Context<AppEnv>): CurrentMember {
  const actor = c.var.actor;
  if (!actor) throw new Error("eventchange: route reached without an actor");
  return actor;
}

function reply(c: Context<AppEnv>, result: EventChangeResult) {
  if (result.ok) {
    return c.json({
      event: {
        id: result.event.id,
        slug: result.event.shareSlug,
        title: result.event.title,
        location: result.event.location,
        startsAt: result.event.startsAt,
        endsAt: result.event.endsAt,
        rsvpCloseAt: result.event.rsvpCloseAt,
        adhocFee: result.event.adhocFee,
        status: result.event.status,
        materialChangeAt: result.event.materialChangeAt,
      },
    });
  }
  if (result.error === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.error === "forbidden") return c.json({ error: "forbidden" }, 403);
  if (result.error === "invalid_body") return c.json({ error: "invalid_body" }, 400);
  return c.json({ error: result.error }, 409);
}

export default new Hono<AppEnv>()
  .use(CANCEL_PATH, contextMiddleware())
  .use(DETAILS_PATH, contextMiddleware())
  .post(
    CANCEL_PATH,
    requireGuard("member"),
    idempotent(`POST /api/v1${CANCEL_PATH}`),
    async (c) => {
      const result = await cancelEvent(c.var.db, c.var.clock, {
        eventId: c.req.param("id"),
        actor: actorOf(c),
        publishOg: eventsDeps().publishOg(c.env),
        onOgError: (error) => {
          c.var.logger.warn("og_publish_failed", { error: String(error) });
        },
      });
      return reply(c, result);
    },
  )
  .patch(
    DETAILS_PATH,
    requireGuard("member"),
    idempotent(`PATCH /api/v1${DETAILS_PATH}`),
    async (c) => {
      const patch = parseDetailsPatch(await c.req.json().catch(() => null));
      if (!patch) return c.json({ error: "invalid_body" }, 400);
      const result = await updateEventDetails(c.var.db, c.var.clock, {
        eventId: c.req.param("id"),
        actor: actorOf(c),
        patch,
        publishOg: eventsDeps().publishOg(c.env),
        onOgError: (error) => {
          c.var.logger.warn("og_publish_failed", { error: String(error) });
        },
      });
      return reply(c, result);
    },
  );
