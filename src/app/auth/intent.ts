/**
 * Sign-in intent: what the visitor was doing before they were sent to sign in, stored so
 * it can be completed after. A logged-out visitor who taps "I'm in" on an event link signs
 * in and lands back on that event with the RSVP still pending (PLAN §10 flow 4).
 * localStorage, not sessionStorage: the email-code and Google flows can reopen the page in
 * a fresh tab or app window.
 */
const KEY = "bcq.signin-intent";
const SIGN_IN_PATH = "/sign-in";

/** An intent older than this is dropped, so a stale tap never fires. */
export const INTENT_TTL_MS = 30 * 60_000;

export interface SignInIntent {
  /** Same-site path to return to after sign-in. */
  readonly returnTo: string;
  /** An RSVP to complete once the member is approved. Consumed by the RSVP screen. */
  readonly rsvp?: { readonly eventSlug: string; readonly response: string };
}

/** Same-site path only. Anything else, and the sign-in page itself, falls back to "/". */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value === SIGN_IN_PATH || value.startsWith(`${SIGN_IN_PATH}?`)) return "/";
  return value;
}

export function saveIntent(intent: SignInIntent, now: number = Date.now()): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ at: now, intent }));
  } catch {
    // Storage blocked (private mode): the user simply signs in without a saved intent.
  }
}

function read(now: number): SignInIntent | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: unknown; intent?: unknown };
    const { at, intent } = parsed;
    if (typeof at !== "number" || now - at > INTENT_TTL_MS) return null;
    if (typeof intent !== "object" || intent === null) return null;
    const { returnTo, rsvp } = intent as { returnTo?: unknown; rsvp?: unknown };
    let out: SignInIntent = {
      returnTo: safeReturnTo(typeof returnTo === "string" ? returnTo : null),
    };
    if (typeof rsvp === "object" && rsvp !== null) {
      const { eventSlug, response } = rsvp as { eventSlug?: unknown; response?: unknown };
      if (typeof eventSlug === "string" && typeof response === "string") {
        out = { ...out, rsvp: { eventSlug, response } };
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Reads the saved intent without consuming it. */
export function peekIntent(now: number = Date.now()): SignInIntent | null {
  return read(now);
}

/** Reads the saved intent and clears it, so a refresh never replays an RSVP. */
export function takeIntent(now: number = Date.now()): SignInIntent | null {
  const intent = read(now);
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
  return intent;
}
