import { apiFetch } from "../../../api/client";

export interface NotificationPrefs {
  readonly globalMute: boolean;
  readonly categories: readonly { readonly category: string; readonly muted: boolean }[];
}

export interface PrefsUpdate {
  readonly globalMute?: boolean;
  readonly categories?: Readonly<Record<string, boolean>>;
}

export function fetchPrefs(signal?: AbortSignal): Promise<NotificationPrefs> {
  return apiFetch<NotificationPrefs>("/notifications/prefs", signal ? { signal } : {});
}

/** Sets absolute values, so it is safe to retry. */
export function savePrefs(update: PrefsUpdate): Promise<NotificationPrefs> {
  return apiFetch<NotificationPrefs>("/notifications/prefs", { method: "PUT", body: update });
}
