/** Browser push seams, injectable for tests. */
export interface PushPort {
  /** null when this browser has no Notification / Push API. */
  permission: () => NotificationPermission | null;
  /** Shows the browser permission prompt. Only ever called from a tap. */
  request: () => Promise<NotificationPermission>;
  /** Registers this device's subscription with the server (S6.2). Best effort. */
  resubscribe: () => Promise<unknown>;
}

function supported(): boolean {
  return (
    typeof Notification !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof PushManager !== "undefined"
  );
}

export const browserPush: PushPort = {
  permission: () => (supported() ? Notification.permission : null),
  request: () => Notification.requestPermission(),
  // Loaded lazily so the push client stays out of the first-load bundle.
  resubscribe: () => import("../../../sw/push-client").then((m) => m.resubscribePush()),
};
