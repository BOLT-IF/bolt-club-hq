import { apiFetch } from "./client";

export interface EventDetail {
  readonly id: string;
  readonly slug: string;
  readonly seriesId: string | null;
  readonly kind: "series" | "member_oneoff" | "admin_oneoff";
  readonly title: string;
  readonly format: string;
  /** ISO 8601, UTC. */
  readonly startsAt: string;
  readonly endsAt: string;
  readonly location: string | null;
  readonly capacity: number;
  readonly adhocFee: number;
  readonly maxGuestsPerMember: number;
  readonly rsvpCloseAt: string;
  readonly allocationMode: "tiered" | "instant";
  readonly audienceKind?: "all" | "series" | "members";
  readonly audienceLabel?: string | null;
  readonly status: "scheduled" | "closed" | "cancelled" | "completed";
  /** Past events cannot be edited. */
  readonly readOnly: boolean;
}

export interface EventViewer {
  readonly canManage: boolean;
  readonly canSeeAttendees: boolean;
}

export interface EventWithViewer {
  readonly event: EventDetail;
  readonly viewer: EventViewer;
}

export async function listEvents(scope: "upcoming" | "past" = "upcoming"): Promise<EventDetail[]> {
  const path = scope === "past" ? "/events?scope=past" : "/events";
  return (await apiFetch<{ events: EventDetail[] }>(path)).events;
}

export function getEventBySlug(slug: string, signal?: AbortSignal): Promise<EventWithViewer> {
  return apiFetch<EventWithViewer>(
    `/events/by-slug/${encodeURIComponent(slug)}`,
    signal ? { signal } : {},
  );
}

export function getSeriesNext(seriesSlug: string): Promise<EventWithViewer> {
  return apiFetch<EventWithViewer>(`/series/by-slug/${encodeURIComponent(seriesSlug)}/next`);
}

export function updateEvent(
  id: string,
  patch: { title?: string; location?: string | null },
): Promise<EventWithViewer> {
  return apiFetch<EventWithViewer>(`/events/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });
}
