import { apiFetch } from "./client";

export interface InboxItem {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface InboxPage {
  readonly items: readonly InboxItem[];
  readonly unreadCount: number;
}

export function fetchNotifications(
  signal?: AbortSignal,
  options: { readonly redirectOnUnauthorized?: boolean } = {},
): Promise<InboxPage> {
  return apiFetch<InboxPage>("/notifications", {
    ...(signal ? { signal } : {}),
    ...(options.redirectOnUnauthorized === undefined
      ? {}
      : { redirectOnUnauthorized: options.redirectOnUnauthorized }),
  });
}

/** Mark some (`ids`) or every (`all`) notification of the current member as read. */
export function markNotificationsRead(
  target: { readonly ids: readonly string[] } | { readonly all: true },
): Promise<{ updated: number }> {
  return apiFetch<{ updated: number }>("/notifications/read", { method: "POST", body: target });
}

const INBOX_UNREAD_EVENT = "bcq:inbox-unread";

export function emitInboxUnread(count: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<number>(INBOX_UNREAD_EVENT, { detail: count }));
}

export function subscribeInboxUnread(listener: (count: number) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail === "number") listener(detail);
  };
  window.addEventListener(INBOX_UNREAD_EVENT, handler);
  return () => {
    window.removeEventListener(INBOX_UNREAD_EVENT, handler);
  };
}
