/**
 * Page-side push subscription (S6.2). PLAN §10: the app re-subscribes on every open.
 *
 * `resubscribePush()` is meant to run at app start; wiring it into the shell is an
 * integrator follow-up. It never asks for permission (asking happens after a meaningful
 * action, from a UI that calls `Notification.requestPermission()` first).
 */
import { apiFetch } from "../app/api/client";

export type ResubscribeResult = "subscribed" | "no-permission" | "unsupported" | "failed";

/** Browser seams, injectable for tests. */
export interface PushEnv {
  /** null when the browser has no Notification / Push API. */
  permission: () => NotificationPermission | null;
  registration: () => Promise<ServiceWorkerRegistration>;
  userAgent: string;
}

function browserEnv(): PushEnv {
  return {
    permission: () =>
      typeof Notification === "undefined" ||
      typeof navigator === "undefined" ||
      !("serviceWorker" in navigator) ||
      typeof PushManager === "undefined"
        ? null
        : Notification.permission,
    registration: () => navigator.serviceWorker.ready,
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
  };
}

/** VAPID public key (base64url) → bytes for `applicationServerKey`. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Makes sure this device's push subscription is registered with the server. Reuses the
 * browser's existing subscription, or creates one when permission is already granted.
 * Best effort: errors resolve to "failed" (the inbox is the source of truth).
 */
export async function resubscribePush(env: PushEnv = browserEnv()): Promise<ResubscribeResult> {
  const permission = env.permission();
  if (permission === null) return "unsupported";
  if (permission !== "granted") return "no-permission";
  try {
    const { pushManager } = await env.registration();
    let subscription = await pushManager.getSubscription();
    if (!subscription) {
      const { publicKey } = await apiFetch<{ publicKey: string }>("/push/vapid-public-key");
      subscription = await pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      });
    }
    const { endpoint, keys } = subscription.toJSON();
    await apiFetch("/push/subscriptions", {
      method: "POST",
      body: { endpoint, keys, userAgent: env.userAgent },
    });
    return "subscribed";
  } catch {
    return "failed";
  }
}

/** Removes this device's subscription on the server and in the browser (e.g. on sign-out). */
export async function unsubscribePush(env: PushEnv = browserEnv()): Promise<void> {
  if (env.permission() === null) return;
  try {
    const subscription = await (await env.registration()).pushManager.getSubscription();
    if (!subscription) return;
    const { endpoint } = subscription.toJSON();
    await apiFetch("/push/subscriptions", { method: "DELETE", body: { endpoint } });
    await subscription.unsubscribe();
  } catch {
    // Best effort.
  }
}
