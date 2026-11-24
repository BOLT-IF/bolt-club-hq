/** Remembered prompt state in localStorage (per device). Storage errors read as "not set". */

const KEYS = {
  rsvped: "bcq.push.rsvped",
  pushDeclined: "bcq.push.declined",
  installDismissed: "bcq.install.dismissed",
} as const;

export type Flag = keyof typeof KEYS;

const EVENT = "bcq-install-state";

export function readFlag(flag: Flag): boolean {
  try {
    return window.localStorage.getItem(KEYS[flag]) === "1";
  } catch {
    return false;
  }
}

export function setFlag(flag: Flag): void {
  try {
    window.localStorage.setItem(KEYS[flag], "1");
  } catch {
    // Private mode: the prompt simply stays hidden for this session.
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Call after the member's RSVP is saved. Unlocks the push card (PLAN §10). */
export function noteRsvpSaved(): void {
  setFlag("rsvped");
}

export function onStateChange(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener(EVENT, listener);
  };
}
