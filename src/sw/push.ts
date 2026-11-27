/// <reference lib="webworker" />
/**
 * Service worker push handling (S6.2). Imported by sw.ts.
 *
 * iOS revokes a push subscription when a push does not show a notification, so the
 * handler ALWAYS calls `showNotification`, even for an empty or malformed payload.
 * Tapping a notification focuses an open app window (or opens one) at the in-app path.
 */

const FALLBACK_TITLE = "BOLT HQ";
const FALLBACK_BODY = "You have a new message.";
const FALLBACK_URL = "/inbox";
const ICON = "/icons/icon-192.png";

interface PushDataLike {
  text(): string;
}

/** Only same-origin app paths; anything else opens the inbox (mirrors S6.1 `resolveLink`). */
function inAppPath(url: unknown): string {
  return typeof url === "string" &&
    url.startsWith("/") &&
    !url.startsWith("//") &&
    !url.startsWith("/\\")
    ? url
    : FALLBACK_URL;
}

const text = (v: unknown, fallback: string): string =>
  typeof v === "string" && v.trim() !== "" ? v : fallback;

export interface PushAction {
  action: string;
  title: string;
}

export type PushNotificationOptions = NotificationOptions & {
  data: { url: string };
  actions?: PushAction[];
};

export function notificationFor(data: PushDataLike | null): {
  title: string;
  options: PushNotificationOptions;
} {
  let raw: string;
  try {
    raw = data?.text() ?? "";
  } catch {
    raw = "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const obj =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;

  const options: PushNotificationOptions = {
    body: obj ? text(obj.body, FALLBACK_BODY) : text(raw, FALLBACK_BODY),
    icon: ICON,
    badge: ICON,
    data: { url: inAppPath(obj?.url) },
  };
  if (obj && typeof obj.tag === "string" && obj.tag !== "") options.tag = obj.tag;
  if (obj && Array.isArray(obj.actions)) {
    const valid = obj.actions
      .filter(
        (a): a is PushAction =>
          typeof a === "object" &&
          a !== null &&
          typeof (a as { action?: unknown }).action === "string" &&
          (a as { action: string }).action.trim() !== "" &&
          typeof (a as { title?: unknown }).title === "string" &&
          (a as { title: string }).title.trim() !== "",
      )
      .slice(0, 2)
      .map((a) => ({ action: a.action.trim(), title: a.title.trim() }));
    if (valid.length > 0) options.actions = valid;
  }
  return { title: obj ? text(obj.title, FALLBACK_TITLE) : FALLBACK_TITLE, options };
}

/** Appends `?quickRsvp=` when the user tapped a push quick-action button. */
export function actionUrl(url: unknown, action?: string): string {
  const base = inAppPath(url);
  if (action !== "going" && action !== "decline") return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}quickRsvp=${action}`;
}

export function showPush(
  registration: Pick<ServiceWorkerRegistration, "showNotification">,
  data: PushDataLike | null,
): Promise<void> {
  const { title, options } = notificationFor(data);
  return registration.showNotification(title, options);
}

interface WindowLike {
  url: string;
  focus(): Promise<unknown>;
  navigate?(url: string): Promise<unknown>;
}
interface ClientsLike {
  matchAll(options?: ClientQueryOptions): Promise<readonly WindowLike[]>;
  openWindow(url: string): Promise<unknown>;
}

export async function focusOrOpen(
  clients: ClientsLike,
  origin: string,
  path: string,
): Promise<void> {
  const target = new URL(inAppPath(path), origin).href;
  const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
  const open = windows.find((w) => new URL(w.url).origin === origin);
  if (open) {
    await open.navigate?.(target);
    await open.focus();
    return;
  }
  await clients.openWindow(target);
}

/** Wires the listeners. Guarded so importing this file outside a worker (tests) is inert. */
function register(): void {
  if (
    typeof ServiceWorkerGlobalScope === "undefined" ||
    !(self instanceof ServiceWorkerGlobalScope)
  ) {
    return;
  }
  const sw = self as unknown as ServiceWorkerGlobalScope;
  sw.addEventListener("push", (event) => {
    event.waitUntil(showPush(sw.registration, event.data));
  });
  sw.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const url = (event.notification.data as { url?: unknown } | null)?.url;
    event.waitUntil(
      focusOrOpen(
        sw.clients as unknown as ClientsLike,
        sw.location.origin,
        actionUrl(url, event.action),
      ),
    );
  });
}

register();
