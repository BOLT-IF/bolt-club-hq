import { describe, expect, it } from "vitest";

import { createWebPushTransport, type VapidConfig } from "./push-transport";

const b64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

async function vapidKeys(): Promise<VapidConfig> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return { subject: "mailto:admin@example.test", publicKey: b64url(raw), privateKey: jwk.d ?? "" };
}

/** A browser-like subscription: an ECDH P-256 public key and a 16-byte auth secret. */
async function subscription(endpoint = "https://push.example.test/sub/1") {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return {
    endpoint,
    keys: { p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) },
  };
}

function mockFetch(status: number | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return status instanceof Error
      ? Promise.reject(status)
      : Promise.resolve(new Response(null, { status }));
  };
  return { fetch, calls };
}

const payload = { title: "Hi", body: "There", url: "/inbox", tag: "ntf_1" };

describe("web push transport (mocked push service)", () => {
  it("success: POSTs an encrypted aes128gcm body with VAPID auth to the endpoint", async () => {
    const { fetch, calls } = mockFetch(201);
    const transport = createWebPushTransport({ vapid: await vapidKeys(), fetch });
    const sub = await subscription();

    expect(await transport.send(sub, payload)).toEqual({ kind: "ok" });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(sub.endpoint);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(headers.get("authorization")).toMatch(/^vapid t=.+, k=.+$/);
    expect(Number(headers.get("ttl"))).toBeGreaterThan(0);
    // Encrypted, so the plaintext title never appears on the wire.
    const body = new TextDecoder().decode(init.body as Uint8Array);
    expect(body).not.toContain("There");
  });

  it.each([404, 410])("%i means the subscription is gone", async (status) => {
    const { fetch } = mockFetch(status);
    const transport = createWebPushTransport({ vapid: await vapidKeys(), fetch });
    expect(await transport.send(await subscription(), payload)).toEqual({ kind: "gone", status });
  });

  it.each([500, 502, 503, 429])("%i is retried later", async (status) => {
    const { fetch } = mockFetch(status);
    const transport = createWebPushTransport({ vapid: await vapidKeys(), fetch });
    expect(await transport.send(await subscription(), payload)).toEqual({ kind: "retry", status });
  });

  it("a network error is retried later", async () => {
    const { fetch } = mockFetch(new Error("offline"));
    const transport = createWebPushTransport({ vapid: await vapidKeys(), fetch });
    expect(await transport.send(await subscription(), payload)).toEqual({
      kind: "retry",
      status: 0,
    });
  });

  it("any other 4xx is rejected without a retry", async () => {
    const { fetch } = mockFetch(400);
    const transport = createWebPushTransport({ vapid: await vapidKeys(), fetch });
    expect(await transport.send(await subscription(), payload)).toEqual({
      kind: "reject",
      status: 400,
    });
  });

  it("a malformed stored subscription is rejected, not thrown", async () => {
    const { fetch, calls } = mockFetch(201);
    const transport = createWebPushTransport({ vapid: await vapidKeys(), fetch });
    const result = await transport.send(
      { endpoint: "https://push.example.test/x", keys: { p256dh: "bad", auth: "bad" } },
      payload,
    );
    expect(result).toEqual({ kind: "reject", status: 0 });
    expect(calls).toHaveLength(0);
  });
});
