import { and, eq, inArray } from "drizzle-orm";

import { eventEligibleMember, member, pass } from "../../../db/schema";
import type { Db, Tx } from "../core/db/client";
import type { CurrentMember } from "../core/ports";

export type EventAudienceKind = "all" | "series" | "members";

export interface EventAudienceTarget {
  readonly id: string;
  readonly createdBy: string;
  readonly audienceKind: string;
  readonly audienceSeriesId: string | null;
}

const unique = (ids: readonly string[]): string[] => [...new Set(ids)].sort();

/** Active members belonging to the event's configured audience (used for notifications). */
export async function resolveEventAudience(db: Db | Tx, e: EventAudienceTarget): Promise<string[]> {
  const active = eq(member.status, "active");
  if (e.audienceKind === "series" && e.audienceSeriesId) {
    const rows = await db
      .select({ id: member.id })
      .from(pass)
      .innerJoin(member, eq(member.id, pass.memberId))
      .where(and(active, eq(pass.seriesId, e.audienceSeriesId), eq(pass.status, "active")));
    return unique(rows.map((r) => r.id));
  }
  if (e.audienceKind === "members") {
    const rows = await db
      .select({ id: member.id })
      .from(eventEligibleMember)
      .innerJoin(member, eq(member.id, eventEligibleMember.memberId))
      .where(and(active, eq(eventEligibleMember.eventId, e.id)));
    return unique(rows.map((r) => r.id));
  }
  const rows = await db.select({ id: member.id }).from(member).where(active);
  return unique(rows.map((r) => r.id));
}

/** Whether `actor` may view and RSVP to `e`. Admins and the organizer always have access. */
export async function canAccessEvent(
  db: Db | Tx,
  actor: CurrentMember | null,
  e: EventAudienceTarget,
): Promise<boolean> {
  if (!actor || actor.status !== "active") return false;
  if (e.audienceKind === "all") return true;
  if (actor.role === "admin" || e.createdBy === actor.id) return true;

  if (e.audienceKind === "series" && e.audienceSeriesId) {
    const [hit] = await db
      .select({ id: pass.id })
      .from(pass)
      .where(
        and(
          eq(pass.seriesId, e.audienceSeriesId),
          eq(pass.memberId, actor.id),
          eq(pass.status, "active"),
        ),
      )
      .limit(1);
    return hit !== undefined;
  }
  if (e.audienceKind === "members") {
    const [hit] = await db
      .select({ memberId: eventEligibleMember.memberId })
      .from(eventEligibleMember)
      .where(and(eq(eventEligibleMember.eventId, e.id), eq(eventEligibleMember.memberId, actor.id)))
      .limit(1);
    return hit !== undefined;
  }
  return false;
}

/** Batched filter for event lists (avoids N+1 queries). */
export async function filterAccessibleEvents<T extends EventAudienceTarget>(
  db: Db | Tx,
  actor: CurrentMember | null,
  events: readonly T[],
): Promise<T[]> {
  if (!actor || actor.status !== "active") return [];
  if (actor.role === "admin") return [...events];

  const seriesIds = unique(
    events
      .filter((e) => e.audienceKind === "series" && e.audienceSeriesId && e.createdBy !== actor.id)
      .map((e) => e.audienceSeriesId as string),
  );
  const memberEventIds = unique(
    events.filter((e) => e.audienceKind === "members" && e.createdBy !== actor.id).map((e) => e.id),
  );

  const [myPasses, myInvites] = await Promise.all([
    seriesIds.length > 0
      ? db
          .select({ seriesId: pass.seriesId })
          .from(pass)
          .where(
            and(
              inArray(pass.seriesId, seriesIds),
              eq(pass.memberId, actor.id),
              eq(pass.status, "active"),
            ),
          )
      : Promise.resolve([]),
    memberEventIds.length > 0
      ? db
          .select({ eventId: eventEligibleMember.eventId })
          .from(eventEligibleMember)
          .where(
            and(
              inArray(eventEligibleMember.eventId, memberEventIds),
              eq(eventEligibleMember.memberId, actor.id),
            ),
          )
      : Promise.resolve([]),
  ]);

  const passSet = new Set(myPasses.map((p) => p.seriesId));
  const inviteSet = new Set(myInvites.map((i) => i.eventId));

  return events.filter((e) => {
    if (e.audienceKind === "all" || e.createdBy === actor.id) return true;
    if (e.audienceKind === "series") {
      return e.audienceSeriesId !== null && passSet.has(e.audienceSeriesId);
    }
    if (e.audienceKind === "members") {
      return inviteSet.has(e.id);
    }
    return false;
  });
}
