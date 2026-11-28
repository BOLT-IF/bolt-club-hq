import { and, asc, eq, inArray, isNull, notExists } from "drizzle-orm";
import { Hono } from "hono";
import { alias } from "drizzle-orm/pg-core";

import { clubSettings, event, guest, ledgerEntry, rsvp } from "../../../db/schema";
import { fillFromWaitlist, promote, type Candidate, type Roster } from "../../domain/allocation";
import { audit } from "../core/audit";
import type { Clock } from "../core/clock";
import { contextMiddleware } from "../core/context";
import type { Db, Tx } from "../core/db/client";
import { publishEvent } from "../core/events";
import { idempotent } from "../core/idempotency";
import { requireActor, requireGuard } from "../core/permissions";
import type { CurrentMember } from "../core/ports";
import { canManageEvent, isReadOnly } from "../events/rules";
import { createLedgerService } from "../ledger/service";
import { createNotifyPort } from "../notifications/notify";
import type { AppEnv } from "../types";
import { closeDueEvents } from "./close";
import type { EventRow, GuestRow, RsvpRow, RsvpStatus } from "./model";

const CAPACITY_PATH = "/events/:id/capacity";
const DEFAULT_CUTOFF_MIN = 180;
const ACTIVE_STATUSES = ["requested", "confirmed", "waitlisted", "offered"] as const;
const isActive = (status: RsvpStatus) =>
  status !== "cancelled" && status !== "late_cancelled" && status !== "declined";

const actorOf = requireActor;

function parseCapacityBody(body: unknown): { capacity: number; override: boolean } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "capacity" && k !== "override")) return null;
  const { capacity, override } = body as { capacity?: unknown; override?: unknown };
  if (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 1) return null;
  if (override !== undefined && typeof override !== "boolean") return null;
  return { capacity, override: override ?? false };
}

async function getCutoffMinutes(tx: Tx): Promise<number> {
  const [settings] = await tx
    .select({ cutoff: clubSettings.autoPromoteCutoffMin })
    .from(clubSettings)
    .where(eq(clubSettings.id, 1));
  return settings?.cutoff ?? DEFAULT_CUTOFF_MIN;
}

async function loadRoster(tx: Tx, e: EventRow) {
  const members = await tx
    .select()
    .from(rsvp)
    .where(and(eq(rsvp.eventId, e.id), inArray(rsvp.status, [...ACTIVE_STATUSES])))
    .orderBy(asc(rsvp.requestedAt), asc(rsvp.id));

  const rsvpIds = members.map((m) => m.id);
  const guests: GuestRow[] =
    rsvpIds.length === 0
      ? []
      : await tx
          .select()
          .from(guest)
          .where(and(inArray(guest.rsvpId, rsvpIds), inArray(guest.status, [...ACTIVE_STATUSES])))
          .orderBy(asc(guest.requestedAt), asc(guest.id));

  const confirmed: Candidate[] = [];
  const waitlist: Candidate[] = [];

  for (const m of members) {
    const candidate: Candidate = {
      kind: "member",
      id: m.id,
      tier: e.kind === "series" && m.tier === 1 ? 1 : 2,
      requestedAt: m.requestedAt.getTime(),
    };
    if (m.status === "confirmed") confirmed.push(candidate);
    else waitlist.push(candidate);
  }

  for (const g of guests) {
    const candidate: Candidate = {
      kind: "guest",
      id: g.id,
      hostId: g.rsvpId,
      tier: 3,
      requestedAt: g.requestedAt.getTime(),
    };
    if (g.status === "confirmed") confirmed.push(candidate);
    else waitlist.push(candidate);
  }

  return {
    roster: { capacity: e.capacity, confirmed, waitlist } satisfies Roster,
    memberById: new Map(members.map((m) => [m.id, m])),
    guestById: new Map(guests.map((g) => [g.id, g])),
    guests,
  };
}

async function reverseUnreversedCharge(
  tx: Tx,
  clock: Clock,
  eventId: string,
  memberId: string,
  guestId: string | null,
): Promise<void> {
  const reversal = alias(ledgerEntry, "reversal");
  const [unreversed] = await tx
    .select({ id: ledgerEntry.id })
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.memberId, memberId),
        eq(ledgerEntry.eventId, eventId),
        eq(ledgerEntry.kind, "charge"),
        guestId ? eq(ledgerEntry.guestId, guestId) : isNull(ledgerEntry.guestId),
        notExists(
          tx
            .select({ id: reversal.id })
            .from(reversal)
            .where(eq(reversal.reversesEntryId, ledgerEntry.id)),
        ),
      ),
    )
    .orderBy(asc(ledgerEntry.createdAt), asc(ledgerEntry.id))
    .limit(1);

  if (unreversed) {
    const ledger = createLedgerService({ db: tx, clock });
    await ledger.reverse({
      entryId: unreversed.id,
      idempotencyKey: `capacity:${unreversed.id}`,
    });
  }
}

async function chargeConfirmedCandidate(
  tx: Tx,
  clock: Clock,
  e: EventRow,
  memberId: string,
  tier: number,
  guestId: string | null,
  keySuffix: string,
): Promise<void> {
  if (e.kind === "member_oneoff" || e.adhocFee <= 0) return;
  if (!guestId && e.kind === "series" && tier === 1) return;

  const ledger = createLedgerService({ db: tx, clock });
  await ledger.charge({
    memberId,
    amountSek: e.adhocFee,
    reason: guestId ? "guest" : "adhoc",
    eventId: e.id,
    ...(guestId ? { guestId } : {}),
    idempotencyKey: `postclose:${e.id}:${keySuffix}`,
  });
}

async function applyPromoted(
  tx: Tx,
  clock: Clock,
  e: EventRow,
  promoted: readonly Candidate[],
  memberById: Map<string, RsvpRow>,
  guestById: Map<string, GuestRow>,
  allGuests: readonly GuestRow[],
  chargeOnConfirm: boolean,
): Promise<number> {
  const now = clock.now();
  const notify = createNotifyPort({ db: tx, clock });
  let count = 0;

  for (const p of promoted) {
    if (p.kind === "member") {
      const row = memberById.get(p.id);
      if (!row) continue;
      const [updated] = await tx
        .update(rsvp)
        .set({ status: "confirmed", confirmedAt: now })
        .where(eq(rsvp.id, row.id))
        .returning();
      if (!updated) continue;

      if (chargeOnConfirm) {
        await chargeConfirmedCandidate(
          tx,
          clock,
          e,
          row.memberId,
          row.tier,
          null,
          `${row.id}:${String(now.getTime())}`,
        );
      }

      const activeGuests = allGuests.filter(
        (g) => g.rsvpId === row.id && isActive(g.status),
      ).length;
      await publishEvent(tx, clock, {
        id: `evo_${crypto.randomUUID()}`,
        type: "rsvp_changed",
        payload: {
          eventId: e.id,
          memberId: row.memberId,
          rsvpId: row.id,
          status: updated.status,
          previousStatus: row.status,
          tier: row.tier,
          guests: activeGuests,
          reason: "promoted",
        },
      });
      await notify.notify({
        memberId: row.memberId,
        category: "rsvp_status",
        title: "You're in",
        body: `A spot opened up for ${e.title} and you've been confirmed.`,
        link: `/events/${e.shareSlug}`,
        idempotencyKey: `promote-notify:${e.id}:${row.id}:${String(now.getTime())}`,
      });
      count++;
    } else {
      const g = guestById.get(p.id);
      if (!g) continue;
      const host = memberById.get(g.rsvpId);
      if (!host) continue;
      await tx.update(guest).set({ status: "confirmed" }).where(eq(guest.id, g.id));
      if (chargeOnConfirm) {
        await chargeConfirmedCandidate(
          tx,
          clock,
          e,
          host.memberId,
          host.tier,
          g.id,
          `guest:${g.id}:${String(now.getTime())}`,
        );
      }
      await notify.notify({
        memberId: host.memberId,
        category: "rsvp_status",
        title: "Guest confirmed",
        body: `Your guest ${g.name} for ${e.title} has been confirmed from the waitlist.`,
        link: `/events/${e.shareSlug}`,
        idempotencyKey: `promote-notify:${e.id}:guest:${g.id}:${String(now.getTime())}`,
      });
      count++;
    }
  }

  return count;
}

export type CapacityResult =
  | {
      ok: true;
      capacity: number;
      waitlistedCount: number;
      promotedCount: number;
      offeredCount: number;
    }
  | { ok: false; error: "not_found" | "forbidden" | "admin_required" | "event_read_only" }
  | { ok: false; error: "capacity_below_confirmed"; confirmedCount: number; capacity: number };

/**
 * Changes an event's capacity (PLAN §6.6).
 * - Lowering below confirmed count is blocked (409) without an admin override.
 * - With admin override, latest confirmed candidates (reverse tier order: guests, non-prepaid, prepaid)
 *   are moved to `waitlisted` and notified.
 * - Raising capacity promotes from the waitlist (auto-promote + refill before cutoff; offer from cutoff).
 */
export async function changeEventCapacity(
  db: Db,
  clock: Clock,
  input: { eventId: string; actor: CurrentMember; capacity: number; override: boolean },
): Promise<CapacityResult> {
  await closeDueEvents(db, clock, { targetEventId: input.eventId });
  const now = clock.now();

  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(event).where(eq(event.id, input.eventId)).for("update");
    if (!e) return { ok: false, error: "not_found" } as const;
    if (!canManageEvent(input.actor, e)) return { ok: false, error: "forbidden" } as const;
    if (isReadOnly(e, now)) return { ok: false, error: "event_read_only" } as const;

    if (input.capacity === e.capacity) {
      return {
        ok: true,
        capacity: e.capacity,
        waitlistedCount: 0,
        promotedCount: 0,
        offeredCount: 0,
      } as const;
    }

    const { roster, memberById, guestById, guests } = await loadRoster(tx, e);

    // Lowering capacity
    if (input.capacity < e.capacity) {
      const confirmedCount = roster.confirmed.length;
      let waitlistedCount = 0;

      if (input.capacity < confirmedCount) {
        if (!input.override) {
          return {
            ok: false,
            error: "capacity_below_confirmed",
            confirmedCount,
            capacity: input.capacity,
          } as const;
        }
        if (input.actor.role !== "admin") {
          return { ok: false, error: "admin_required" } as const;
        }

        // Bump excess confirmed candidates in reverse priority order:
        // tier 3 (guests) latest first -> tier 2 latest first -> tier 1 (prepaid) latest first.
        const toBump = [...roster.confirmed].sort((a, b) => {
          if (a.tier !== b.tier) return b.tier - a.tier;
          if (a.requestedAt !== b.requestedAt) return b.requestedAt - a.requestedAt;
          return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
        });

        const excess = confirmedCount - input.capacity;
        const notify = createNotifyPort({ db: tx, clock });

        for (let i = 0; i < excess; i++) {
          const target = toBump[i];
          if (!target) break;

          if (target.kind === "member") {
            const row = memberById.get(target.id);
            if (!row) continue;
            const [updated] = await tx
              .update(rsvp)
              .set({ status: "waitlisted", confirmedAt: null })
              .where(eq(rsvp.id, row.id))
              .returning();
            if (!updated) continue;

            await reverseUnreversedCharge(tx, clock, e.id, row.memberId, null);

            const activeGuests = guests.filter(
              (g) => g.rsvpId === row.id && isActive(g.status),
            ).length;
            await publishEvent(tx, clock, {
              id: `evo_${crypto.randomUUID()}`,
              type: "rsvp_changed",
              payload: {
                eventId: e.id,
                memberId: row.memberId,
                rsvpId: row.id,
                status: "waitlisted",
                previousStatus: "confirmed",
                tier: row.tier,
                guests: activeGuests,
                reason: "rsvp",
              },
            });
            await notify.notify({
              memberId: row.memberId,
              category: "rsvp_status",
              title: "Moved to waitlist",
              body: `Capacity for ${e.title} was reduced, so you have been moved to the waitlist.`,
              link: `/events/${e.shareSlug}`,
              idempotencyKey: `capacity-waitlist:${e.id}:${row.id}:${String(now.getTime())}`,
            });
            waitlistedCount++;
          } else {
            const g = guestById.get(target.id);
            if (!g) continue;
            const host = memberById.get(g.rsvpId);
            if (!host) continue;

            await tx.update(guest).set({ status: "waitlisted" }).where(eq(guest.id, g.id));
            await reverseUnreversedCharge(tx, clock, e.id, host.memberId, g.id);

            await notify.notify({
              memberId: host.memberId,
              category: "rsvp_status",
              title: "Guest moved to waitlist",
              body: `Capacity for ${e.title} was reduced, so your guest ${g.name} has been moved to the waitlist.`,
              link: `/events/${e.shareSlug}`,
              idempotencyKey: `capacity-waitlist:${e.id}:guest:${g.id}:${String(now.getTime())}`,
            });
            waitlistedCount++;
          }
        }
      }

      if (confirmedCount >= input.capacity) {
        // No free spots remain: any pending "offered" spots can no longer be claimed.
        await tx
          .update(rsvp)
          .set({ status: "waitlisted" })
          .where(and(eq(rsvp.eventId, e.id), eq(rsvp.status, "offered")));
        const eventRsvpIds = [...memberById.keys()];
        if (eventRsvpIds.length > 0) {
          await tx
            .update(guest)
            .set({ status: "waitlisted" })
            .where(and(inArray(guest.rsvpId, eventRsvpIds), eq(guest.status, "offered")));
        }
      }

      await tx.update(event).set({ capacity: input.capacity }).where(eq(event.id, e.id));
      await audit(
        tx,
        clock,
        {
          actorId: input.actor.id,
          action: "event.capacity",
          entity: "event",
          entityId: e.id,
          before: { capacity: e.capacity },
          after: { capacity: input.capacity, ...(input.override ? { override: true } : {}) },
        },
        `aud_${crypto.randomUUID()}`,
      );

      return {
        ok: true,
        capacity: input.capacity,
        waitlistedCount,
        promotedCount: 0,
        offeredCount: 0,
      } as const;
    }

    // Raising capacity
    const [updatedEvent] = await tx
      .update(event)
      .set({ capacity: input.capacity })
      .where(eq(event.id, e.id))
      .returning();
    if (!updatedEvent) throw new Error("changeEventCapacity: update returned no row");

    const updatedRoster: Roster = { ...roster, capacity: input.capacity };
    let promotedCount = 0;
    let offeredCount = 0;

    if (e.status === "closed") {
      const cutoffMinutes = await getCutoffMinutes(tx);
      const promo = promote({
        mode: e.allocationMode,
        roster: updatedRoster,
        now: now.getTime(),
        startsAt: e.startsAt.getTime(),
        cutoffMinutes,
      });

      if (promo.phase === "auto") {
        promotedCount = await applyPromoted(
          tx,
          clock,
          updatedEvent,
          promo.promoted,
          memberById,
          guestById,
          guests,
          true,
        );
      } else {
        const notify = createNotifyPort({ db: tx, clock });
        for (const candidate of promo.offeredTo) {
          if (candidate.kind === "member") {
            const row = memberById.get(candidate.id);
            if (!row || row.status === "offered") continue;
            await tx.update(rsvp).set({ status: "offered" }).where(eq(rsvp.id, row.id));
            await notify.notify({
              memberId: row.memberId,
              category: "rsvp_status",
              title: "Spot available",
              body: `A spot opened up for ${e.title}. Tap to claim it.`,
              link: `/events/${e.shareSlug}`,
              idempotencyKey: `offer-notify:${e.id}:${row.id}:${String(now.getTime())}`,
            });
            offeredCount++;
          } else {
            const g = guestById.get(candidate.id);
            if (!g || g.status === "offered") continue;
            const host = memberById.get(g.rsvpId);
            if (!host) continue;
            await tx.update(guest).set({ status: "offered" }).where(eq(guest.id, g.id));
            await notify.notify({
              memberId: host.memberId,
              category: "rsvp_status",
              title: "Spot available for guest",
              body: `A spot opened up for your guest ${g.name} at ${e.title}. Tap to claim it.`,
              link: `/events/${e.shareSlug}`,
              idempotencyKey: `offer-notify:${e.id}:guest:${g.id}:${String(now.getTime())}`,
            });
            offeredCount++;
          }
        }
      }
    } else if (e.status === "scheduled" && e.allocationMode === "instant") {
      const filled = fillFromWaitlist("instant", updatedRoster);
      promotedCount = await applyPromoted(
        tx,
        clock,
        updatedEvent,
        filled.promoted,
        memberById,
        guestById,
        guests,
        false,
      );
    }

    await audit(
      tx,
      clock,
      {
        actorId: input.actor.id,
        action: "event.capacity",
        entity: "event",
        entityId: e.id,
        before: { capacity: e.capacity },
        after: { capacity: input.capacity },
      },
      `aud_${crypto.randomUUID()}`,
    );

    return {
      ok: true,
      capacity: input.capacity,
      waitlistedCount: 0,
      promotedCount,
      offeredCount,
    } as const;
  });
}

export default new Hono<AppEnv>()
  .use(CAPACITY_PATH, contextMiddleware())
  .patch(
    CAPACITY_PATH,
    requireGuard("member"),
    idempotent(`PATCH /api/v1${CAPACITY_PATH}`),
    async (c) => {
      const parsed = parseCapacityBody(await c.req.json().catch(() => null));
      if (!parsed) return c.json({ error: "invalid_body" }, 400);

      const result = await changeEventCapacity(c.var.db, c.var.clock, {
        eventId: c.req.param("id"),
        actor: actorOf(c),
        capacity: parsed.capacity,
        override: parsed.override,
      });

      if (result.ok) {
        return c.json({
          capacity: result.capacity,
          waitlistedCount: result.waitlistedCount,
          promotedCount: result.promotedCount,
          offeredCount: result.offeredCount,
        });
      }
      if (result.error === "not_found") return c.json({ error: "not_found" }, 404);
      if (result.error === "forbidden" || result.error === "admin_required") {
        return c.json({ error: result.error }, 403);
      }
      if (result.error === "capacity_below_confirmed") {
        return c.json(
          {
            error: result.error,
            confirmedCount: result.confirmedCount,
            capacity: result.capacity,
          },
          409,
        );
      }
      return c.json({ error: result.error }, 409);
    },
  );
