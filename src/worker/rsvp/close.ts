import { and, asc, eq, inArray, isNull, lte, ne } from "drizzle-orm";

import { event, guest, rsvp } from "../../../db/schema";
import { allocate, type Candidate } from "../../domain/allocation";
import type { Clock } from "../core/clock";
import type { Db, Tx } from "../core/db/client";
import { publishEvent } from "../core/events";
import { createLedgerService } from "../ledger/service";
import { createNotifyPort } from "../notifications/notify";

type EventRow = typeof event.$inferSelect;
type RsvpRow = typeof rsvp.$inferSelect;
type GuestRow = typeof guest.$inferSelect;

/** PLAN §6.3: a single read closes at most 5 due events. */
export const CLOSE_ON_READ_LIMIT = 5;

const ACTIVE_STATUSES = ["requested", "confirmed", "waitlisted"] as const;

export interface CloseDueOptions {
  /** Max due events to close in one call. Default 5 (PLAN §6.3); null means uncapped (cron). */
  limit?: number | null;
  /** Prioritize this event id if due (e.g. GET /events/:id or GET /events/:id/rsvp). */
  targetEventId?: string;
  /** Prioritize this share slug if due (e.g. GET /events/by-slug/:slug). */
  targetSlug?: string;
}

function buildCloseNotification(
  e: EventRow,
  memberAfter: "confirmed" | "waitlisted",
  memberChanged: boolean,
  memberChargedSek: number,
  confirmedGuestCount: number,
  waitlistedGuestCount: number,
): { title: string; body: string } {
  if (memberAfter === "waitlisted") {
    return {
      title: "On the waitlist",
      body: `You're on the waitlist for ${e.title}`,
    };
  }
  const parts: string[] = [e.title];
  if (confirmedGuestCount > 0) {
    parts.push(
      `${String(confirmedGuestCount)} ${confirmedGuestCount === 1 ? "guest" : "guests"} confirmed`,
    );
  }
  if (waitlistedGuestCount > 0) {
    parts.push(
      `${String(waitlistedGuestCount)} ${waitlistedGuestCount === 1 ? "guest" : "guests"} waitlisted`,
    );
  }
  if (memberChargedSek > 0) {
    parts.push(`${String(memberChargedSek)} kr charged`);
  }
  return {
    title: memberChanged ? "You're in" : "RSVP update",
    body: parts.join(" · "),
  };
}

/**
 * Closes one event inside a single transaction (PLAN §6.3):
 * 1. Lock the event row (`FOR UPDATE SKIP LOCKED`) and re-check `closed_processed_at`.
 * 2. Run the S4.1 allocation engine and persist confirmed/waitlisted statuses (`confirmedAt` from Clock).
 * 3. Write ledger charges (`close:<eventId>:<memberId>`, guest charges to host with `guestId`).
 * 4. Queue notifications once (`close-notify:<eventId>:<memberId>`, `rsvp_status`) and publish `event_closed`.
 *
 * Returns true if this call closed the event, false if already closed, not due, or locked by another worker.
 */
export async function closeEvent(db: Db, clock: Clock, eventId: string): Promise<boolean> {
  const now = clock.now();
  return db.transaction(async (tx) => {
    const [e] = await tx
      .select()
      .from(event)
      .where(eq(event.id, eventId))
      .for("update", { skipLocked: true });

    if (!e || e.closedProcessedAt !== null || e.status !== "scheduled" || e.rsvpCloseAt > now) {
      return false;
    }

    const activeRsvps = await tx
      .select()
      .from(rsvp)
      .where(and(eq(rsvp.eventId, e.id), inArray(rsvp.status, [...ACTIVE_STATUSES])))
      .orderBy(asc(rsvp.requestedAt), asc(rsvp.id));

    const rsvpIds = activeRsvps.map((r) => r.id);
    const activeGuests: GuestRow[] =
      rsvpIds.length === 0
        ? []
        : await tx
            .select()
            .from(guest)
            .where(and(inArray(guest.rsvpId, rsvpIds), inArray(guest.status, [...ACTIVE_STATUSES])))
            .orderBy(asc(guest.requestedAt), asc(guest.id));

    const candidates: Candidate[] = [
      ...activeRsvps.map((r) => ({
        kind: "member" as const,
        id: r.id,
        // PLAN §6.8: tier 1 only on series events; admin/member one-offs never have tier 1.
        tier: e.kind === "series" && r.tier === 1 ? (1 as const) : (2 as const),
        requestedAt: r.requestedAt.getTime(),
      })),
      ...activeGuests.map((g) => ({
        kind: "guest" as const,
        id: g.id,
        hostId: g.rsvpId,
        tier: 3 as const,
        requestedAt: g.requestedAt.getTime(),
      })),
    ];

    const roster = allocate({ mode: e.allocationMode, capacity: e.capacity, candidates });

    const confirmedMemberIds = new Set(
      roster.confirmed.filter((c) => c.kind === "member").map((c) => c.id),
    );
    const waitlistedMemberIds = new Set(
      roster.waitlist.filter((c) => c.kind === "member").map((c) => c.id),
    );
    const confirmedGuestIds = new Set(
      roster.confirmed.filter((c) => c.kind === "guest").map((c) => c.id),
    );
    const waitlistedGuestIds = new Set(
      roster.waitlist.filter((c) => c.kind === "guest").map((c) => c.id),
    );

    await persistAllocation(
      tx,
      now,
      activeRsvps,
      activeGuests,
      confirmedMemberIds,
      waitlistedMemberIds,
      confirmedGuestIds,
      waitlistedGuestIds,
    );

    await tx
      .update(event)
      .set({ status: "closed", closedProcessedAt: now })
      .where(eq(event.id, e.id));

    const chargedByMember = await chargeConfirmed(
      tx,
      clock,
      e,
      activeRsvps,
      activeGuests,
      confirmedMemberIds,
      confirmedGuestIds,
    );

    await notifyParticipants(
      tx,
      clock,
      e,
      activeRsvps,
      activeGuests,
      confirmedMemberIds,
      confirmedGuestIds,
      chargedByMember,
    );

    await publishEvent(tx, clock, {
      id: `evo_close_${e.id}`,
      type: "event_closed",
      payload: {
        eventId: e.id,
        closedAt: now.toISOString(),
        confirmedCount: roster.confirmed.length,
        waitlistedCount: roster.waitlist.length,
      },
    });

    return true;
  });
}

async function persistAllocation(
  tx: Tx,
  now: Date,
  activeRsvps: readonly RsvpRow[],
  activeGuests: readonly GuestRow[],
  confirmedMemberIds: ReadonlySet<string>,
  waitlistedMemberIds: ReadonlySet<string>,
  confirmedGuestIds: ReadonlySet<string>,
  waitlistedGuestIds: ReadonlySet<string>,
): Promise<void> {
  const rsvpToConfirm = activeRsvps
    .filter((r) => confirmedMemberIds.has(r.id) && (r.status !== "confirmed" || !r.confirmedAt))
    .map((r) => r.id);
  if (rsvpToConfirm.length > 0) {
    await tx
      .update(rsvp)
      .set({ status: "confirmed", confirmedAt: now })
      .where(inArray(rsvp.id, rsvpToConfirm));
  }

  const rsvpToWaitlist = activeRsvps
    .filter(
      (r) => waitlistedMemberIds.has(r.id) && (r.status !== "waitlisted" || r.confirmedAt !== null),
    )
    .map((r) => r.id);
  if (rsvpToWaitlist.length > 0) {
    await tx
      .update(rsvp)
      .set({ status: "waitlisted", confirmedAt: null })
      .where(inArray(rsvp.id, rsvpToWaitlist));
  }

  const guestsToConfirm = activeGuests
    .filter((g) => confirmedGuestIds.has(g.id) && g.status !== "confirmed")
    .map((g) => g.id);
  if (guestsToConfirm.length > 0) {
    await tx.update(guest).set({ status: "confirmed" }).where(inArray(guest.id, guestsToConfirm));
  }

  const guestsToWaitlist = activeGuests
    .filter((g) => waitlistedGuestIds.has(g.id) && g.status !== "waitlisted")
    .map((g) => g.id);
  if (guestsToWaitlist.length > 0) {
    await tx.update(guest).set({ status: "waitlisted" }).where(inArray(guest.id, guestsToWaitlist));
  }
}

async function chargeConfirmed(
  tx: Tx,
  clock: Clock,
  e: EventRow,
  activeRsvps: readonly RsvpRow[],
  activeGuests: readonly GuestRow[],
  confirmedMemberIds: ReadonlySet<string>,
  confirmedGuestIds: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const chargedByMember = new Map<string, number>();
  // PLAN §5.2 inv. 6, §6.4: member one-offs are always free and never touch the ledger.
  if (e.kind === "member_oneoff" || e.adhocFee <= 0) {
    return chargedByMember;
  }

  const ledger = createLedgerService({ db: tx, clock });
  const rsvpById = new Map(activeRsvps.map((r) => [r.id, r]));

  for (const r of activeRsvps) {
    if (!confirmedMemberIds.has(r.id)) continue;
    // Prepaid series members (tier 1) are never charged for themselves.
    // Admin one-offs have no tier 1 (PLAN §6.8): everyone confirmed pays.
    if (e.kind === "series" && r.tier === 1) continue;

    await ledger.charge({
      memberId: r.memberId,
      amountSek: e.adhocFee,
      reason: "adhoc",
      eventId: e.id,
      idempotencyKey: `close:${e.id}:${r.memberId}`,
    });
    chargedByMember.set(r.memberId, (chargedByMember.get(r.memberId) ?? 0) + e.adhocFee);
  }

  for (const g of activeGuests) {
    if (!confirmedGuestIds.has(g.id)) continue;
    const host = rsvpById.get(g.rsvpId);
    if (!host) continue;

    // Guests are always charged to their host, even when the host is prepaid (PLAN §6.4).
    await ledger.charge({
      memberId: host.memberId,
      amountSek: e.adhocFee,
      reason: "guest",
      eventId: e.id,
      guestId: g.id,
      idempotencyKey: `close:${e.id}:guest:${g.id}`,
    });
    chargedByMember.set(host.memberId, (chargedByMember.get(host.memberId) ?? 0) + e.adhocFee);
  }

  return chargedByMember;
}

async function notifyParticipants(
  tx: Tx,
  clock: Clock,
  e: EventRow,
  activeRsvps: readonly RsvpRow[],
  activeGuests: readonly GuestRow[],
  confirmedMemberIds: ReadonlySet<string>,
  confirmedGuestIds: ReadonlySet<string>,
  chargedByMember: ReadonlyMap<string, number>,
): Promise<void> {
  const notify = createNotifyPort({ db: tx, clock });
  const guestsByRsvp = new Map<string, GuestRow[]>();
  for (const g of activeGuests) {
    const list = guestsByRsvp.get(g.rsvpId);
    if (list) list.push(g);
    else guestsByRsvp.set(g.rsvpId, [g]);
  }

  for (const r of activeRsvps) {
    const afterStatus: "confirmed" | "waitlisted" = confirmedMemberIds.has(r.id)
      ? "confirmed"
      : "waitlisted";
    const memberChanged = r.status !== afterStatus;

    const myGuests = guestsByRsvp.get(r.id) ?? [];
    let confirmedGuestCount = 0;
    let waitlistedGuestCount = 0;
    let guestChanged = false;
    for (const g of myGuests) {
      const gAfter = confirmedGuestIds.has(g.id) ? "confirmed" : "waitlisted";
      if (gAfter === "confirmed") confirmedGuestCount += 1;
      else waitlistedGuestCount += 1;
      if (g.status !== gAfter) guestChanged = true;
    }

    if (!memberChanged && !guestChanged) continue;

    const { title, body } = buildCloseNotification(
      e,
      afterStatus,
      memberChanged,
      chargedByMember.get(r.memberId) ?? 0,
      confirmedGuestCount,
      waitlistedGuestCount,
    );

    await notify.notify({
      memberId: r.memberId,
      category: "rsvp_status",
      title,
      body,
      link: `/events/${e.shareSlug}`,
      idempotencyKey: `close-notify:${e.id}:${r.memberId}`,
    });
  }
}

/**
 * Finds due scheduled events (`rsvpCloseAt <= now`, `closedProcessedAt IS NULL`) and closes
 * up to `limit` of them (default 5 for close-on-read; pass `limit: null` in the cron hook).
 */
export async function closeDueEvents(
  db: Db,
  clock: Clock,
  options: CloseDueOptions = {},
): Promise<number> {
  const limit = options.limit === undefined ? CLOSE_ON_READ_LIMIT : options.limit;
  if (limit !== null && limit <= 0) return 0;

  const now = clock.now();
  const baseCond = and(
    eq(event.status, "scheduled"),
    isNull(event.closedProcessedAt),
    lte(event.rsvpCloseAt, now),
  );

  const ids: string[] = [];
  let targetId: string | undefined;
  const targetCond = options.targetEventId
    ? eq(event.id, options.targetEventId)
    : options.targetSlug
      ? eq(event.shareSlug, options.targetSlug)
      : null;

  if (targetCond) {
    const [hit] = await db
      .select({ id: event.id })
      .from(event)
      .where(and(baseCond, targetCond))
      .limit(1);
    if (hit) {
      targetId = hit.id;
      ids.push(hit.id);
    }
  }

  const remaining = limit === null ? null : limit - ids.length;
  if (remaining === null || remaining > 0) {
    const cond = targetId !== undefined ? and(baseCond, ne(event.id, targetId)) : baseCond;
    const query = db
      .select({ id: event.id })
      .from(event)
      .where(cond)
      .orderBy(asc(event.rsvpCloseAt), asc(event.id));
    const more = remaining === null ? await query : await query.limit(remaining);
    for (const row of more) ids.push(row.id);
  }

  let closed = 0;
  for (const id of ids) {
    if (await closeEvent(db, clock, id)) closed += 1;
  }
  return closed;
}

/** Earliest `rsvpCloseAt` among unclosed scheduled events, or null when none remain. */
export async function nextCloseDueAt(db: Db): Promise<Date | null> {
  const [row] = await db
    .select({ rsvpCloseAt: event.rsvpCloseAt })
    .from(event)
    .where(and(eq(event.status, "scheduled"), isNull(event.closedProcessedAt)))
    .orderBy(asc(event.rsvpCloseAt))
    .limit(1);
  return row?.rsvpCloseAt ?? null;
}
