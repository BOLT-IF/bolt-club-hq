import { and, eq } from "drizzle-orm";

import { event, guest, member, rsvp } from "../../../db/schema";
import { audit } from "../core/audit";
import type { Clock } from "../core/clock";
import type { Db, Tx } from "../core/db/client";
import type { CurrentMember } from "../core/ports";
import { canManageEvent } from "../events/rules";

export type MarkableAttendance = "attended" | "no_show";
export type StoredAttendance = "unknown" | MarkableAttendance;

export const ATTENDANCE_LOCK_MS = 7 * 24 * 60 * 60 * 1000;
export const ATTENDANCE_ALERT_DELAY_MS = 24 * 60 * 60 * 1000;

export function isAttendanceLockedForOrganizer(endsAt: Date, now: Date): boolean {
  return now.getTime() >= endsAt.getTime() + ATTENDANCE_LOCK_MS;
}

export interface AttendanceItemInput {
  readonly id: string;
  readonly attendance: MarkableAttendance;
}

export interface MarkAttendanceInput {
  readonly rsvps: readonly AttendanceItemInput[];
  readonly guests: readonly AttendanceItemInput[];
}

export interface AttendanceRowView {
  readonly kind: "member" | "guest";
  readonly id: string;
  readonly memberId?: string;
  readonly rsvpId?: string;
  readonly hostName?: string;
  readonly name: string;
  readonly tier: number;
  readonly attendance: StoredAttendance;
  readonly effectiveAttendance: MarkableAttendance;
  readonly requestedAt: string;
}

export interface AttendanceView {
  readonly eventId: string;
  readonly lockedForOrganizer: boolean;
  readonly canEdit: boolean;
  readonly hasUnmarked: boolean;
  readonly attendees: readonly AttendanceRowView[];
}

export type GetAttendanceResult =
  | { readonly ok: true; readonly data: AttendanceView }
  | { readonly ok: false; readonly error: "not_found" | "forbidden" };

export type PutAttendanceResult =
  | { readonly ok: true; readonly data: AttendanceView }
  | {
      readonly ok: false;
      readonly error:
        "not_found" | "forbidden" | "event_cancelled" | "attendance_locked" | "invalid_attendee";
    };

async function loadAttendanceView(
  db: Db | Tx,
  clock: Clock,
  eventRow: {
    id: string;
    endsAt: Date;
  },
  actor: CurrentMember,
): Promise<AttendanceView> {
  const memberRows = await db
    .select({
      id: rsvp.id,
      memberId: rsvp.memberId,
      name: member.displayName,
      tier: rsvp.tier,
      attendance: rsvp.attendance,
      requestedAt: rsvp.requestedAt,
    })
    .from(rsvp)
    .innerJoin(member, eq(member.id, rsvp.memberId))
    .where(and(eq(rsvp.eventId, eventRow.id), eq(rsvp.status, "confirmed")));

  const guestRows = await db
    .select({
      id: guest.id,
      rsvpId: guest.rsvpId,
      hostName: member.displayName,
      name: guest.name,
      tier: guest.tier,
      attendance: guest.attendance,
      requestedAt: guest.requestedAt,
    })
    .from(guest)
    .innerJoin(rsvp, eq(rsvp.id, guest.rsvpId))
    .innerJoin(member, eq(member.id, rsvp.memberId))
    .where(and(eq(rsvp.eventId, eventRow.id), eq(guest.status, "confirmed")));

  const attendees: AttendanceRowView[] = [
    ...memberRows.map((row) => ({
      kind: "member" as const,
      id: row.id,
      memberId: row.memberId,
      name: row.name,
      tier: row.tier,
      attendance: row.attendance,
      effectiveAttendance: row.attendance === "unknown" ? "attended" : row.attendance,
      requestedAt: row.requestedAt.toISOString(),
    })),
    ...guestRows.map((row) => ({
      kind: "guest" as const,
      id: row.id,
      rsvpId: row.rsvpId,
      hostName: row.hostName,
      name: row.name,
      tier: row.tier,
      attendance: row.attendance,
      effectiveAttendance: row.attendance === "unknown" ? "attended" : row.attendance,
      requestedAt: row.requestedAt.toISOString(),
    })),
  ].sort(
    (a, b) =>
      a.tier - b.tier || a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id),
  );

  const lockedForOrganizer = isAttendanceLockedForOrganizer(eventRow.endsAt, clock.now());
  return {
    eventId: eventRow.id,
    lockedForOrganizer,
    canEdit: actor.role === "admin" || !lockedForOrganizer,
    hasUnmarked: attendees.some((a) => a.attendance === "unknown"),
    attendees,
  };
}

export async function getAttendance(
  db: Db,
  clock: Clock,
  eventId: string,
  actor: CurrentMember,
): Promise<GetAttendanceResult> {
  const [eventRow] = await db.select().from(event).where(eq(event.id, eventId));
  if (!eventRow) return { ok: false, error: "not_found" };
  if (!canManageEvent(actor, eventRow)) return { ok: false, error: "forbidden" };
  return { ok: true, data: await loadAttendanceView(db, clock, eventRow, actor) };
}

export async function putAttendance(
  db: Db,
  clock: Clock,
  eventId: string,
  actor: CurrentMember,
  input: MarkAttendanceInput,
): Promise<PutAttendanceResult> {
  const outcome = await db.transaction(async (tx): Promise<PutAttendanceResult> => {
    const [eventRow] = await tx.select().from(event).where(eq(event.id, eventId)).for("update");
    if (!eventRow) return { ok: false, error: "not_found" };
    if (!canManageEvent(actor, eventRow)) return { ok: false, error: "forbidden" };
    if (eventRow.status === "cancelled") return { ok: false, error: "event_cancelled" };
    if (isAttendanceLockedForOrganizer(eventRow.endsAt, clock.now()) && actor.role !== "admin") {
      return { ok: false, error: "attendance_locked" };
    }

    const confirmedRsvps = await tx
      .select({ id: rsvp.id, attendance: rsvp.attendance })
      .from(rsvp)
      .where(and(eq(rsvp.eventId, eventId), eq(rsvp.status, "confirmed")));

    const confirmedGuests = await tx
      .select({ id: guest.id, attendance: guest.attendance })
      .from(guest)
      .innerJoin(rsvp, eq(rsvp.id, guest.rsvpId))
      .where(and(eq(rsvp.eventId, eventId), eq(guest.status, "confirmed")));

    const rsvpMap = new Map(confirmedRsvps.map((r) => [r.id, r.attendance]));
    const guestMap = new Map(confirmedGuests.map((g) => [g.id, g.attendance]));

    for (const item of input.rsvps) {
      if (!rsvpMap.has(item.id)) return { ok: false, error: "invalid_attendee" };
    }
    for (const item of input.guests) {
      if (!guestMap.has(item.id)) return { ok: false, error: "invalid_attendee" };
    }

    const before: {
      rsvps: Record<string, StoredAttendance>;
      guests: Record<string, StoredAttendance>;
    } = {
      rsvps: {},
      guests: {},
    };
    const after: {
      rsvps: Record<string, MarkableAttendance>;
      guests: Record<string, MarkableAttendance>;
    } = {
      rsvps: {},
      guests: {},
    };

    for (const item of input.rsvps) {
      before.rsvps[item.id] = rsvpMap.get(item.id) ?? "unknown";
      after.rsvps[item.id] = item.attendance;
      await tx.update(rsvp).set({ attendance: item.attendance }).where(eq(rsvp.id, item.id));
    }

    for (const item of input.guests) {
      before.guests[item.id] = guestMap.get(item.id) ?? "unknown";
      after.guests[item.id] = item.attendance;
      await tx.update(guest).set({ attendance: item.attendance }).where(eq(guest.id, item.id));
    }

    await audit(
      tx,
      clock,
      {
        actorId: actor.id,
        action: "attendance.mark",
        entity: "event",
        entityId: eventId,
        before,
        after,
      },
      `aud_${crypto.randomUUID()}`,
    );

    return {
      ok: true,
      data: await loadAttendanceView(tx, clock, eventRow, actor),
    };
  });

  return outcome;
}
