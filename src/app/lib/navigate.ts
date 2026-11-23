import { useSyncExternalStore } from "react";

/** Marks entries pushed by the app, so Back can use history.back() safely. */
const APP_STATE_KEY = "bcq";

function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => {
    window.removeEventListener("popstate", listener);
  };
}

function currentPath(): string {
  return window.location.pathname;
}

/** Reactive pathname. Updates on Back/Forward and on navigate(). */
export function useCurrentPath(): string {
  return useSyncExternalStore(subscribe, currentPath, () => "/");
}

/** Client-side navigation. Does nothing when already on the target path. */
export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState({ [APP_STATE_KEY]: true }, "", path);
  // pushState does not fire popstate; dispatch it so useCurrentPath re-renders.
  const state: unknown = window.history.state;
  window.dispatchEvent(new PopStateEvent("popstate", { state }));
}

/** Parent of a path: "/events/42" -> "/events", "/events" -> "/". */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

/**
 * Explicit back control target. Uses history.back() when the previous entry was
 * also pushed by the app; after a fresh deep link it goes to the parent route.
 */
export function goBack(fallback: string = parentPath(currentPath())): void {
  const state: unknown = window.history.state;
  const fromApp =
    typeof state === "object" && state !== null && Object.hasOwn(state, APP_STATE_KEY);
  if (fromApp) {
    window.history.back();
    return;
  }
  navigate(fallback);
}

/** Whether `path` is `target` or a sub-path of it. */
export function isActivePath(path: string, target: string): boolean {
  if (target === "/") return path === "/";
  return path === target || path.startsWith(`${target}/`);
}
