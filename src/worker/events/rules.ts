import type { CurrentMember } from "../core/ports";

export type EventStatus = "scheduled" | "closed" | "cancelled" | "completed";

/** Past events (ended, completed or cancelled) cannot be edited. A `closed` event has only stopped taking RSVPs. */
export function isReadOnly(e: { status: EventStatus; endsAt: Date }, now: Date): boolean {
  return e.status === "completed" || e.status === "cancelled" || e.endsAt <= now;
}

/** What `/series/…/next` may return: still scheduled, RSVPs open, not over. */
export function isOpenForNext(
  e: { status: EventStatus; rsvpCloseAt: Date; endsAt: Date },
  now: Date,
): boolean {
  return e.status === "scheduled" && e.rsvpCloseAt > now && e.endsAt > now;
}

/** PLAN §4: admin all; creator their own one-off; captain their own series. */
export function canManageEvent(
  actor: CurrentMember | null,
  e: {
    kind: "series" | "member_oneoff" | "admin_oneoff";
    seriesId: string | null;
    createdBy: string;
  },
): boolean {
  if (!actor || actor.status !== "active") return false;
  if (actor.role === "admin") return true;
  if (e.kind !== "series" && e.createdBy === actor.id) return true;
  return e.seriesId !== null && actor.seriesIds.includes(e.seriesId);
}

/** A3: approved (active) members see attendee names; pending members and visitors do not. */
export function canSeeAttendees(actor: CurrentMember | null): boolean {
  return actor?.status === "active";
}

export function eventOgKey(slug: string): string {
  return `og:event:${slug}`;
}

/**
 * The public facts S7.1 builds the share page from. Never the creator or anyone's name
 * (PLAN §7: no attendee names in OG). Published as JSON through `PublishOgPort`.
 */
export function ogSnapshot(e: {
  shareSlug: string;
  title: string;
  format: string;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  status: EventStatus;
}): string {
  return JSON.stringify({
    slug: e.shareSlug,
    title: e.title,
    format: e.format,
    location: e.location,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    status: e.status,
  });
}
