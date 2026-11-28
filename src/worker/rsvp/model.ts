import { and, asc, eq, inArray, ne } from "drizzle-orm";

import { event, guest, rsvp } from "../../../db/schema";
import { fillFromWaitlist, type Candidate } from "../../domain/allocation";
import type { Clock } from "../core/clock";
import type { Db, Tx } from "../core/db/client";
import { publishEvent } from "../core/events";
import type { PrepaidPort } from "../core/ports";
import { rsvpTier } from "../events/oneoff-rules";

export type EventRow = typeof event.$inferSelect;
export type RsvpRow = typeof rsvp.$inferSelect;
export type GuestRow = typeof guest.$inferSelect;
export type RsvpStatus = RsvpRow["status"];

export const MAX_GUEST_NAME = 60;
/** PLAN A4: guests have a display name only. A blank name is shown as "Guest". */
export const DEFAULT_GUEST_NAME = "Guest";

export interface RsvpView {
  id: string;
  status: RsvpStatus;
  tier: number;
  guests: Array<{ id: string; name: string; status: RsvpStatus }>;
}

export type RsvpResult =
  | { ok: true; rsvp: RsvpView | null }
  | { ok: false; error: "not_found" | "rsvp_closed" | "guest_limit"; max?: number };

/** Pre-close RSVPs are taken only while the event is scheduled, the window is open and it has not ended. */
export function isRsvpOpen(e: EventRow, now: Date): boolean {
  return e.status === "scheduled" && e.rsvpCloseAt > now && e.endsAt > now;
}

const isActive = (status: RsvpStatus) =>
  status !== "cancelled" && status !== "late_cancelled" && status !== "declined";

function toView(row: RsvpRow, guests: readonly GuestRow[]): RsvpView {
  return {
    id: row.id,
    status: row.status,
    tier: row.tier,
    guests: isActive(row.status)
      ? guests
          .filter((g) => isActive(g.status))
          .map((g) => ({ id: g.id, name: g.name, status: g.status }))
      : [],
  };
}

async function lockEvent(tx: Tx, eventId: string): Promise<EventRow | undefined> {
  const [row] = await tx.select().from(event).where(eq(event.id, eventId)).for("update");
  return row;
}

async function findRsvp(db: Db | Tx, eventId: string, memberId: string) {
  const [row] = await db
    .select()
    .from(rsvp)
    .where(and(eq(rsvp.eventId, eventId), eq(rsvp.memberId, memberId)));
  return row;
}

async function guestsOf(db: Db | Tx, rsvpId: string): Promise<GuestRow[]> {
  return db
    .select()
    .from(guest)
    .where(eq(guest.rsvpId, rsvpId))
    .orderBy(asc(guest.requestedAt), asc(guest.id));
}

export async function getRsvp(db: Db, eventId: string, memberId: string) {
  const [e] = await db.select({ id: event.id }).from(event).where(eq(event.id, eventId));
  if (!e) return { ok: false as const, error: "not_found" as const };
  const row = await findRsvp(db, eventId, memberId);
  return { ok: true as const, rsvp: row ? toView(row, await guestsOf(db, row.id)) : null };
}

interface ChangeEvent {
  row: RsvpRow;
  previousStatus: RsvpStatus | null;
  guests: number;
  reason: "rsvp" | "cancel" | "decline" | "promoted" | "member_exit";
}

async function emit(tx: Tx, clock: Clock, change: ChangeEvent): Promise<void> {
  await publishEvent(tx, clock, {
    id: `evo_${crypto.randomUUID()}`,
    type: "rsvp_changed",
    payload: {
      eventId: change.row.eventId,
      memberId: change.row.memberId,
      rsvpId: change.row.id,
      status: change.row.status,
      previousStatus: change.previousStatus,
      tier: change.row.tier,
      guests: change.guests,
      reason: change.reason,
    },
  });
}

/**
 * Instant mode (PLAN §6.1, §6.8): fills free seats from the waitlist, first-come, through the
 * S4.1 engine. Confirmed people are never moved. Returns members whose own status changed,
 * other than `exceptRsvpId` (the caller reports that one itself).
 */
async function fillInstant(tx: Tx, clock: Clock, e: EventRow, exceptRsvpId?: string) {
  const members = await tx
    .select()
    .from(rsvp)
    .where(and(eq(rsvp.eventId, e.id), inArray(rsvp.status, ["confirmed", "waitlisted"])));
  const memberIds = members.map((m) => m.id);
  const guests =
    memberIds.length === 0
      ? []
      : await tx
          .select()
          .from(guest)
          .where(
            and(
              inArray(guest.rsvpId, memberIds),
              inArray(guest.status, ["confirmed", "waitlisted"]),
            ),
          );

  const toCandidate = (status: string) => (status === "confirmed" ? "confirmed" : "waitlist");
  const roster = {
    capacity: e.capacity,
    confirmed: [] as Candidate[],
    waitlist: [] as Candidate[],
  };
  for (const m of members) {
    roster[toCandidate(m.status)].push({
      kind: "member",
      id: m.id,
      tier: m.tier === 1 ? 1 : 2,
      requestedAt: m.requestedAt.getTime(),
    });
  }
  for (const g of guests) {
    roster[toCandidate(g.status)].push({
      kind: "guest",
      id: g.id,
      hostId: g.rsvpId,
      tier: 3,
      requestedAt: g.requestedAt.getTime(),
    });
  }

  const { promoted } = fillFromWaitlist("instant", roster);
  const now = clock.now();
  const promotedMembers = promoted.filter((p) => p.kind === "member").map((p) => p.id);
  const promotedGuests = promoted.filter((p) => p.kind === "guest").map((p) => p.id);
  if (promotedGuests.length > 0) {
    await tx.update(guest).set({ status: "confirmed" }).where(inArray(guest.id, promotedGuests));
  }
  if (promotedMembers.length === 0) return;
  const updated = await tx
    .update(rsvp)
    .set({ status: "confirmed", confirmedAt: now })
    .where(inArray(rsvp.id, promotedMembers))
    .returning();
  for (const row of updated) {
    if (row.id === exceptRsvpId) continue;
    const count = (await guestsOf(tx, row.id)).filter((g) => isActive(g.status)).length;
    await emit(tx, clock, { row, previousStatus: "waitlisted", guests: count, reason: "promoted" });
  }
}

export interface PutRsvpInput {
  eventId: string;
  memberId: string;
  /** Guest names in display order; length is the guest count. */
  guests: string[];
}

/**
 * PUT /events/:id/rsvp before close (PLAN §6.1). One row per member per event: a repeat PUT
 * updates it, a PUT after a cancel reopens it with a new request time. The event row lock
 * serialises every RSVP write for the event, so capacity and "one RSVP per member" hold
 * under concurrent requests (there is no unique index on (event_id, member_id)).
 */
export async function putRsvp(
  db: Db,
  clock: Clock,
  prepaid: PrepaidPort,
  input: PutRsvpInput,
): Promise<RsvpResult> {
  const now = clock.now();

  return db.transaction(async (tx) => {
    const e = await lockEvent(tx, input.eventId);
    if (!e) return { ok: false, error: "not_found" } as const;
    if (!isRsvpOpen(e, now)) return { ok: false, error: "rsvp_closed" } as const;
    if (input.guests.length > e.maxGuestsPerMember) {
      return { ok: false, error: "guest_limit", max: e.maxGuestsPerMember } as const;
    }

    // Tier 1 only exists on series events (admin one-offs have none, member one-offs are instant).
    // Evaluated inside the transaction after locking the event row so pass issuance/revocation serializes cleanly.
    const isPrepaid =
      e.kind === "series"
        ? await prepaid.isPrepaid({ memberId: input.memberId, eventId: e.id, tx })
        : false;
    const tier = rsvpTier(e, isPrepaid);

    const instant = e.allocationMode === "instant";
    const existing = await findRsvp(tx, e.id, input.memberId);
    const reopening = !existing || !isActive(existing.status);
    const previousStatus = existing?.status ?? null;
    const before = existing ? toView(existing, await guestsOf(tx, existing.id)) : null;

    // Instant mode places people with the engine below; new entries start on the waitlist.
    const tieredStatus: RsvpStatus = tier === 1 ? "confirmed" : "requested";
    let row: RsvpRow;
    if (!existing) {
      const [created] = await tx
        .insert(rsvp)
        .values({
          id: `rsv_${crypto.randomUUID()}`,
          eventId: e.id,
          memberId: input.memberId,
          status: instant ? "waitlisted" : tieredStatus,
          tier,
          requestedAt: now,
          confirmedAt: !instant && tier === 1 ? now : null,
        })
        .returning();
      if (!created) throw new Error("putRsvp: insert returned no row");
      row = created;
    } else {
      const status: RsvpStatus = instant
        ? reopening
          ? "waitlisted"
          : existing.status
        : // Tiered: a member's status follows their tier (a pass bought later upgrades it, §6.5).
          tieredStatus;
      const [updated] = await tx
        .update(rsvp)
        .set({
          status,
          tier,
          ...(reopening ? { requestedAt: now, cancelledAt: null, confirmedAt: null } : {}),
          ...(status === "confirmed" && existing.status !== "confirmed"
            ? { confirmedAt: now }
            : {}),
          ...(!instant && status !== "confirmed" ? { confirmedAt: null } : {}),
        })
        .where(eq(rsvp.id, existing.id))
        .returning();
      if (!updated) throw new Error("putRsvp: update returned no row");
      row = updated;
    }

    // Guests: keep the earliest active ones (renamed in order), cancel extras, add the rest.
    const active = reopening ? [] : (await guestsOf(tx, row.id)).filter((g) => isActive(g.status));
    for (const [i, g] of active.entries()) {
      const name = input.guests[i];
      if (name === undefined) {
        await tx.update(guest).set({ status: "cancelled" }).where(eq(guest.id, g.id));
      } else if (name !== g.name) {
        await tx.update(guest).set({ name }).where(eq(guest.id, g.id));
      }
    }
    const newGuestStatus: RsvpStatus = instant ? "waitlisted" : "requested";
    const added = input.guests.slice(active.length);
    if (added.length > 0) {
      await tx.insert(guest).values(
        // Guests added together share requested_at; the padded index keeps (requested_at, id)
        // in the order the member entered them, so later renames and trims hit the right guest.
        added.map((name, i) => ({
          id: `gst_${String(active.length + i).padStart(2, "0")}_${crypto.randomUUID()}`,
          rsvpId: row.id,
          name,
          status: newGuestStatus,
          tier: 3,
          requestedAt: now,
        })),
      );
    }

    if (instant) {
      await fillInstant(tx, clock, e, row.id);
      row = (await findRsvp(tx, e.id, input.memberId)) ?? row;
    }

    const after = toView(row, await guestsOf(tx, row.id));
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await emit(tx, clock, { row, previousStatus, guests: after.guests.length, reason: "rsvp" });
    }
    return { ok: true, rsvp: after } as const;
  });
}

/** Cancels one RSVP and its guests inside a transaction that already holds the event lock. No ledger writes (§6.4). */
async function cancelLocked(
  tx: Tx,
  clock: Clock,
  e: EventRow,
  row: RsvpRow,
  reason: "cancel" | "member_exit",
): Promise<RsvpRow> {
  const [cancelled] = await tx
    .update(rsvp)
    .set({ status: "cancelled", cancelledAt: clock.now() })
    .where(eq(rsvp.id, row.id))
    .returning();
  if (!cancelled) throw new Error("cancelRsvp: update returned no row");
  await tx
    .update(guest)
    .set({ status: "cancelled" })
    .where(and(eq(guest.rsvpId, row.id), ne(guest.status, "cancelled")));
  if (e.allocationMode === "instant") await fillInstant(tx, clock, e);
  await emit(tx, clock, { row: cancelled, previousStatus: row.status, guests: 0, reason });
  return cancelled;
}

/** DELETE /events/:id/rsvp before close: CANCELLED, no fee (PLAN §6.1). Already cancelled is a no-op. */
export async function cancelRsvp(
  db: Db,
  clock: Clock,
  input: { eventId: string; memberId: string },
): Promise<RsvpResult> {
  return db.transaction(async (tx) => {
    const e = await lockEvent(tx, input.eventId);
    if (!e) return { ok: false, error: "not_found" } as const;
    if (!isRsvpOpen(e, clock.now())) return { ok: false, error: "rsvp_closed" } as const;
    const row = await findRsvp(tx, e.id, input.memberId);
    if (!row) return { ok: false, error: "not_found" } as const;
    const result = isActive(row.status) ? await cancelLocked(tx, clock, e, row, "cancel") : row;
    return { ok: true, rsvp: toView(result, []) } as const;
  });
}

/**
 * POST /events/:id/rsvp/decline before close: marks the member as explicitly not going (`declined`),
 * suppressing `event_unrsvped` reminders. If they previously had an active RSVP, cancels any guests
 * and promotes from the waitlist in instant mode. Already declined is a no-op.
 */
export async function declineRsvp(
  db: Db,
  clock: Clock,
  input: { eventId: string; memberId: string },
): Promise<RsvpResult> {
  const now = clock.now();
  return db.transaction(async (tx) => {
    const e = await lockEvent(tx, input.eventId);
    if (!e) return { ok: false, error: "not_found" } as const;
    if (!isRsvpOpen(e, now)) return { ok: false, error: "rsvp_closed" } as const;

    const existing = await findRsvp(tx, e.id, input.memberId);
    if (!existing) {
      const [created] = await tx
        .insert(rsvp)
        .values({
          id: `rsv_${crypto.randomUUID()}`,
          eventId: e.id,
          memberId: input.memberId,
          status: "declined",
          tier: rsvpTier(e, false),
          requestedAt: now,
          confirmedAt: null,
          cancelledAt: null,
        })
        .returning();
      if (!created) throw new Error("declineRsvp: insert returned no row");
      await emit(tx, clock, { row: created, previousStatus: null, guests: 0, reason: "decline" });
      return { ok: true, rsvp: toView(created, []) } as const;
    }

    if (existing.status === "declined") {
      return { ok: true, rsvp: toView(existing, []) } as const;
    }

    const wasActive = isActive(existing.status);
    const [declined] = await tx
      .update(rsvp)
      .set({
        status: "declined",
        confirmedAt: null,
        cancelledAt: wasActive ? now : existing.cancelledAt,
      })
      .where(eq(rsvp.id, existing.id))
      .returning();
    if (!declined) throw new Error("declineRsvp: update returned no row");

    if (wasActive) {
      await tx
        .update(guest)
        .set({ status: "cancelled" })
        .where(and(eq(guest.rsvpId, existing.id), ne(guest.status, "cancelled")));
      if (e.allocationMode === "instant") await fillInstant(tx, clock, e);
    }
    await emit(tx, clock, {
      row: declined,
      previousStatus: existing.status,
      guests: 0,
      reason: "decline",
    });
    return { ok: true, rsvp: toView(declined, []) } as const;
  });
}

/**
 * For S2.1's `rsvp.cancel` port (member deactivation, PLAN §6.7). Cancels the member's RSVPs
 * on events whose RSVP window is still open at `at`: those are pre-close cancels, so no fee.
 * RSVPs on events that already closed are left alone: late-cancel rules belong to S4.3/S4.4a.
 * Idempotent: a cancelled RSVP is skipped, so a retry with the same key changes nothing.
 */
export async function cancelMemberRsvps(
  db: Db,
  clock: Clock,
  input: { memberId: string; at: Date; idempotencyKey: string },
): Promise<void> {
  const rows = await db
    .select({ eventId: rsvp.eventId })
    .from(rsvp)
    .where(
      and(
        eq(rsvp.memberId, input.memberId),
        inArray(rsvp.status, ["requested", "confirmed", "waitlisted", "offered"]),
      ),
    );
  for (const { eventId } of rows) {
    await db.transaction(async (tx) => {
      const e = await lockEvent(tx, eventId);
      if (!e || !isRsvpOpen(e, input.at)) return;
      const row = await findRsvp(tx, eventId, input.memberId);
      if (row && isActive(row.status)) await cancelLocked(tx, clock, e, row, "member_exit");
    });
  }
}
