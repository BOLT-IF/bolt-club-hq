import { apiFetch, newIdempotencyKey } from "../../api/client";
import type { EventDetail } from "../../api/events";

export const RSVP_UPDATED_EVENT = "bcq:rsvp-updated";

export function isClosedAndEditable(e: EventDetail): boolean {
  if (e.readOnly || e.status === "cancelled" || e.status === "completed") return false;
  return e.status === "closed" || new Date(e.rsvpCloseAt).getTime() <= Date.now();
}

export function notifyRsvpUpdated(eventId: string): void {
  window.dispatchEvent(new CustomEvent(RSVP_UPDATED_EVENT, { detail: { eventId } }));
}

export type RsvpStatus =
  | "requested"
  | "confirmed"
  | "waitlisted"
  | "offered"
  | "cancelled"
  | "late_cancelled"
  | "declined";

export interface RsvpView {
  readonly id: string;
  readonly status: RsvpStatus;
  readonly tier: number;
  readonly guests: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly status: RsvpStatus;
  }>;
}

const path = (eventId: string) => `/events/${encodeURIComponent(eventId)}/rsvp`;

export async function getMyRsvp(eventId: string): Promise<RsvpView | null> {
  return (await apiFetch<{ rsvp: RsvpView | null }>(path(eventId))).rsvp;
}

/** `key` is created once per user action, so a retry of the same tap replays instead of repeating. */
export async function putRsvp(
  eventId: string,
  guests: readonly string[],
  key: string = newIdempotencyKey(),
): Promise<RsvpView> {
  const res = await apiFetch<{ rsvp: RsvpView }>(path(eventId), {
    method: "PUT",
    body: { guests },
    idempotencyKey: key,
  });
  return res.rsvp;
}

export async function cancelRsvp(
  eventId: string,
  key: string = newIdempotencyKey(),
): Promise<RsvpView> {
  const res = await apiFetch<{ rsvp: RsvpView }>(path(eventId), {
    method: "DELETE",
    idempotencyKey: key,
  });
  return res.rsvp;
}

export async function declineRsvp(
  eventId: string,
  key: string = newIdempotencyKey(),
): Promise<RsvpView> {
  const res = await apiFetch<{ rsvp: RsvpView }>(`${path(eventId)}/decline`, {
    method: "POST",
    idempotencyKey: key,
  });
  return res.rsvp;
}
