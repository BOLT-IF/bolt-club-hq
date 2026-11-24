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
