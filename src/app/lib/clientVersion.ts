import { useSyncExternalStore } from "react";

/** Sent as X-Client-Version. The server answers 426 when it is too old (PLAN §11.5). */
export const CLIENT_VERSION = "1";

let outdated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isClientOutdated(): boolean {
  return outdated;
}

/** Called by apiFetch on HTTP 426. Shows the refresh banner. */
export function markClientOutdated(): void {
  if (outdated) return;
  outdated = true;
  emit();
}

export function resetClientOutdatedForTests(): void {
  outdated = false;
  emit();
}

export function useClientOutdated(): boolean {
  return useSyncExternalStore(subscribe, isClientOutdated, () => false);
}
