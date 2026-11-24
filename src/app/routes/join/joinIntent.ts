import { ApiError, apiFetch, newIdempotencyKey } from "../../api/client";

/**
 * The RSVP a pending member asked for before they were approved (PLAN §7 flow 5). The server
 * has nowhere to keep it (`join_request` has no intent column and stories add no migrations),
 * so it lives here and is completed on the first app open after approval. Separate from the
 * 30-minute sign-in intent (`auth/intent.ts`) because an approval can take days.
 */
const KEY = "bcq.join-rsvp-intent";
export const JOIN_INTENT_TTL_MS = 14 * 86_400_000;

export interface JoinRsvpIntent {
  readonly eventSlug: string;
  /** Reused on every attempt, so a retried PUT replays instead of repeating. */
  readonly idempotencyKey: string;
  readonly savedAt: number;
}

export function peekJoinRsvpIntent(now: number = Date.now()): JoinRsvpIntent | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<JoinRsvpIntent>;
    if (typeof v.eventSlug !== "string" || typeof v.idempotencyKey !== "string") return null;
    if (typeof v.savedAt !== "number" || now - v.savedAt > JOIN_INTENT_TTL_MS) return null;
    return { eventSlug: v.eventSlug, idempotencyKey: v.idempotencyKey, savedAt: v.savedAt };
  } catch {
    return null;
  }
}

/** Saves (or refreshes) the intent. The same event keeps its idempotency key. */
export function saveJoinRsvpIntent(eventSlug: string, now: number = Date.now()): void {
  const existing = peekJoinRsvpIntent(now);
  const idempotencyKey =
    existing?.eventSlug === eventSlug ? existing.idempotencyKey : newIdempotencyKey();
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ eventSlug, idempotencyKey, savedAt: now }));
  } catch {
    // Storage blocked: the member RSVPs by hand after approval.
  }
}

export function clearJoinRsvpIntent(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

export type CompleteResult =
  | { readonly kind: "none" }
  | { readonly kind: "waiting" }
  | { readonly kind: "retry" }
  | { readonly kind: "done"; readonly eventSlug: string }
  | { readonly kind: "dropped"; readonly eventSlug: string };

const isClientError = (e: unknown) => e instanceof ApiError && e.status >= 400 && e.status < 500;

/**
 * Sends the stored RSVP once the member is active. Never overwrites an RSVP they already
 * have. A refusal (RSVPs closed, event gone) drops the intent; a network or server error
 * keeps it for the next open.
 */
export async function completeJoinRsvpIntent(now: number = Date.now()): Promise<CompleteResult> {
  const intent = peekJoinRsvpIntent(now);
  if (!intent) {
    clearJoinRsvpIntent();
    return { kind: "none" };
  }
  const { eventSlug } = intent;
  try {
    const me = await apiFetch<{ status: string }>("/me");
    if (me.status !== "active") return { kind: "waiting" };
  } catch (error) {
    return isClientError(error) ? { kind: "waiting" } : { kind: "retry" };
  }
  try {
    const { event } = await apiFetch<{ event: { id: string } }>(
      `/events/by-slug/${encodeURIComponent(eventSlug)}`,
    );
    const rsvpPath = `/events/${encodeURIComponent(event.id)}/rsvp`;
    const { rsvp } = await apiFetch<{ rsvp: unknown }>(rsvpPath);
    if (rsvp === null) {
      await apiFetch(rsvpPath, {
        method: "PUT",
        body: { guests: [] },
        idempotencyKey: intent.idempotencyKey,
      });
    }
    clearJoinRsvpIntent();
    return { kind: "done", eventSlug };
  } catch (error) {
    if (!isClientError(error)) return { kind: "retry" };
    clearJoinRsvpIntent();
    return { kind: "dropped", eventSlug };
  }
}
