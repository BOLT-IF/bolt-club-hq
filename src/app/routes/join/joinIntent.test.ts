import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../api/client";
import {
  JOIN_INTENT_TTL_MS,
  clearJoinRsvpIntent,
  completeJoinRsvpIntent,
  peekJoinRsvpIntent,
  saveJoinRsvpIntent,
} from "./joinIntent";

const T0 = 1_800_000_000_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Handler = (method: string, path: string, init?: RequestInit) => Response;

function stub(handler: Handler) {
  const calls: Array<{ method: string; path: string; key: string | null; body: unknown }> = [];
  configureApiClient({
    onUnauthorized: () => undefined,
    fetch: (input, init) => {
      const path = input.replace("/api/v1", "");
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, key: headers.get("Idempotency-Key"), body });
      return Promise.resolve(handler(method, path, init));
    },
  });
  return calls;
}

const active = { id: "m1", role: "member", status: "active", seriesIds: [] };
const pending = { ...active, status: "pending" };
const eventBody = { event: { id: "evt_1", slug: "eventslug1" }, viewer: {} };

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  configureApiClient({});
  vi.restoreAllMocks();
});

describe("join RSVP intent", () => {
  it("is stored with a stable idempotency key and outlives the 30-minute sign-in intent", () => {
    saveJoinRsvpIntent("eventslug1", T0);
    const first = peekJoinRsvpIntent(T0 + 3 * 86_400_000);
    expect(first?.eventSlug).toBe("eventslug1");
    expect(first?.idempotencyKey).toMatch(/.{8,}/);
    saveJoinRsvpIntent("eventslug1", T0 + 1000);
    expect(peekJoinRsvpIntent(T0 + 2000)?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(peekJoinRsvpIntent(T0 + JOIN_INTENT_TTL_MS + 1)).toBeNull();
    clearJoinRsvpIntent();
    expect(peekJoinRsvpIntent(T0)).toBeNull();
  });

  it("does nothing while the member is still pending", async () => {
    saveJoinRsvpIntent("eventslug1");
    const calls = stub((_m, path) => (path === "/me" ? json(200, pending) : json(500, {})));
    expect(await completeJoinRsvpIntent()).toEqual({ kind: "waiting" });
    expect(calls.map((c) => c.path)).toEqual(["/me"]);
    expect(peekJoinRsvpIntent()).not.toBeNull();
  });

  it("approval completes the stored intent: one RSVP PUT with the stored key, then cleared", async () => {
    saveJoinRsvpIntent("eventslug1");
    const key = peekJoinRsvpIntent()?.idempotencyKey;
    const calls = stub((method, path) => {
      if (path === "/me") return json(200, active);
      if (path === "/events/by-slug/eventslug1") return json(200, eventBody);
      if (method === "GET" && path === "/events/evt_1/rsvp") return json(200, { rsvp: null });
      if (method === "PUT" && path === "/events/evt_1/rsvp")
        return json(200, { rsvp: { id: "r1", status: "requested", tier: 2, guests: [] } });
      return json(500, {});
    });
    expect(await completeJoinRsvpIntent()).toEqual({ kind: "done", eventSlug: "eventslug1" });
    const put = calls.filter((c) => c.method === "PUT");
    expect(put).toHaveLength(1);
    expect(put[0]).toMatchObject({ key, body: { guests: [] } });
    expect(peekJoinRsvpIntent()).toBeNull();
    expect(await completeJoinRsvpIntent()).toEqual({ kind: "none" });
  });

  it("never overwrites an RSVP the member already has", async () => {
    saveJoinRsvpIntent("eventslug1");
    const calls = stub((method, path) => {
      if (path === "/me") return json(200, active);
      if (path === "/events/by-slug/eventslug1") return json(200, eventBody);
      if (method === "GET" && path === "/events/evt_1/rsvp")
        return json(200, { rsvp: { id: "r1", status: "confirmed", tier: 1, guests: [{}] } });
      return json(500, {});
    });
    expect(await completeJoinRsvpIntent()).toEqual({ kind: "done", eventSlug: "eventslug1" });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(peekJoinRsvpIntent()).toBeNull();
  });

  it("drops the intent when RSVPs closed or the event is gone, keeps it on a network error", async () => {
    saveJoinRsvpIntent("eventslug1");
    stub((method, path) => {
      if (path === "/me") return json(200, active);
      if (path === "/events/by-slug/eventslug1") return json(200, eventBody);
      if (method === "GET") return json(200, { rsvp: null });
      return json(409, { error: "rsvp_closed" });
    });
    expect(await completeJoinRsvpIntent()).toEqual({ kind: "dropped", eventSlug: "eventslug1" });
    expect(peekJoinRsvpIntent()).toBeNull();

    saveJoinRsvpIntent("eventslug1");
    configureApiClient({ fetch: () => Promise.reject(new TypeError("offline")) });
    expect(await completeJoinRsvpIntent()).toEqual({ kind: "retry" });
    expect(peekJoinRsvpIntent()).not.toBeNull();
  });
});
