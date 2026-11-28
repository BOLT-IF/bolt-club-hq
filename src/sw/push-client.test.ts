import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../app/api/client";
import { resubscribePush, unsubscribePush, type PushEnv } from "./push-client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubApi() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  configureApiClient({
    fetch: (url, init) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.endsWith("/push/vapid-public-key"))
        return Promise.resolve(json({ publicKey: "AQAB" }));
      return Promise.resolve(json({}));
    },
  });
  return calls;
}

function env(overrides: Partial<PushEnv> = {}, existing: PushSubscriptionJSON | null = null) {
  const subscription = {
    endpoint: "https://push.example.test/new",
    toJSON: () => ({ endpoint: "https://push.example.test/new", keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  };
  const current = existing
    ? { ...subscription, toJSON: () => existing, endpoint: existing.endpoint ?? "" }
    : null;
  const pushManager = {
    getSubscription: vi.fn(() => Promise.resolve(current)),
    subscribe: vi.fn(() => Promise.resolve(subscription)),
  };
  const e: PushEnv = {
    permission: () => "granted",
    registration: () => Promise.resolve({ pushManager } as unknown as ServiceWorkerRegistration),
    userAgent: "TestAgent",
    ...overrides,
  };
  return { e, pushManager, subscription };
}

afterEach(() => {
  configureApiClient({});
});

describe("resubscribePush (called on every app open)", () => {
  it("subscribes with the server's VAPID key and registers the subscription", async () => {
    const calls = stubApi();
    const { e, pushManager } = env();
    expect(await resubscribePush(e)).toBe("subscribed");
    expect(pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 0, 1]),
    });
    expect(calls.at(-1)).toEqual({
      url: "/api/v1/push/subscriptions",
      method: "POST",
      body: {
        endpoint: "https://push.example.test/new",
        keys: { p256dh: "p", auth: "a" },
        userAgent: "TestAgent",
      },
    });
  });

  it("re-registers an existing browser subscription without creating a new one", async () => {
    const calls = stubApi();
    const existing = {
      endpoint: "https://push.example.test/old",
      keys: { p256dh: "x", auth: "y" },
    };
    const { e, pushManager } = env({}, existing);
    expect(await resubscribePush(e)).toBe("subscribed");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(calls.at(-1)?.body).toMatchObject({ endpoint: "https://push.example.test/old" });
  });

  it("never prompts: without granted permission it does nothing", async () => {
    const calls = stubApi();
    const { e, pushManager } = env({ permission: () => "default" });
    expect(await resubscribePush(e)).toBe("no-permission");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("reports unsupported browsers instead of throwing", async () => {
    const { e } = env({ permission: () => null });
    expect(await resubscribePush(e)).toBe("unsupported");
  });

  it("swallows server errors (push is best effort; the inbox is the source of truth)", async () => {
    configureApiClient({ fetch: () => Promise.resolve(json({ error: "x" }, 500)) });
    const { e } = env();
    expect(await resubscribePush(e)).toBe("failed");
  });

  it("does not trigger onUnauthorized redirect when /push/vapid-public-key returns 401", async () => {
    const onUnauthorized = vi.fn();
    configureApiClient({
      fetch: () => Promise.resolve(json({ error: "unauthorized" }, 401)),
      onUnauthorized,
    });
    const { e } = env();
    expect(await resubscribePush(e)).toBe("failed");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("unsubscribePush", () => {
  it("removes the subscription on the server and in the browser", async () => {
    const calls = stubApi();
    const existing = {
      endpoint: "https://push.example.test/old",
      keys: { p256dh: "x", auth: "y" },
    };
    const { e } = env({}, existing);
    await unsubscribePush(e);
    expect(calls.at(-1)).toEqual({
      url: "/api/v1/push/subscriptions",
      method: "DELETE",
      body: { endpoint: "https://push.example.test/old" },
    });
  });
});
