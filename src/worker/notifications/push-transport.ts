import { buildPushPayload } from "@block65/webcrypto-web-push";

export type PushAction = {
  action: string;
  title: string;
};

/** What the service worker receives (src/sw/push.ts reads the same shape). */
export type PushPayload = {
  title: string;
  body: string;
  /** In-app path to open on tap. */
  url: string;
  /** Notification tag, so a re-delivery replaces instead of stacking. */
  tag: string;
  /** Optional quick-action buttons (rendered on platforms that support Notification.actions). */
  actions?: PushAction[];
};

export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Outcome of one send. `gone` = 404/410 (delete the subscription), `retry` = 5xx, 429 or a
 * network error (status 0) → back off, `reject` = any other failure (do not retry).
 */
export type PushResult =
  | { kind: "ok" }
  | { kind: "gone"; status: 404 | 410 }
  | { kind: "retry"; status: number }
  | { kind: "reject"; status: number };

export interface PushTransport {
  send(subscription: StoredSubscription, payload: PushPayload): Promise<PushResult>;
}

export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** Push services hold a message this long while the device is offline (RFC 8030 TTL). */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;

/**
 * RFC 8291 encryption + RFC 8292 VAPID through WebCrypto (`@block65/webcrypto-web-push`),
 * so it runs on Workers. One call encrypts and POSTs to one subscription.
 */
export function createWebPushTransport(deps: {
  vapid: VapidConfig;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}): PushTransport {
  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  return {
    async send(subscription, payload) {
      let request: Awaited<ReturnType<typeof buildPushPayload>>;
      try {
        request = await buildPushPayload(
          {
            data: { ...payload },
            options: { ttl: PUSH_TTL_SECONDS, urgency: "normal" },
          },
          { ...subscription, expirationTime: null },
          deps.vapid,
        );
      } catch {
        // Malformed stored keys (or a non-https endpoint): retrying cannot fix it.
        return { kind: "reject", status: 0 };
      }

      let status: number;
      try {
        const res = await doFetch(subscription.endpoint, {
          method: "POST",
          headers: request.headers,
          body: request.body,
        });
        status = res.status;
      } catch {
        return { kind: "retry", status: 0 };
      }

      if (status >= 200 && status < 300) return { kind: "ok" };
      if (status === 404 || status === 410) return { kind: "gone", status };
      if (status >= 500 || status === 429) return { kind: "retry", status };
      return { kind: "reject", status };
    },
  };
}
