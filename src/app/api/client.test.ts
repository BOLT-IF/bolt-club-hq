import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLIENT_VERSION, apiFetch, configureApiClient, newIdempotencyKey } from "./client";
import { isClientOutdated, resetClientOutdatedForTests } from "../lib/clientVersion";

function jsonResponse(status: number, body: unknown = null): Response {
  if (body === null) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("apiFetch", () => {
  beforeEach(() => {
    resetClientOutdatedForTests();
    window.history.pushState({}, "", "/");
  });

  afterEach(() => {
    configureApiClient({});
    vi.restoreAllMocks();
  });

  it("sends the Clerk bearer token, X-Client-Version and the Idempotency-Key header", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { ok: true })));
    configureApiClient({ getToken: () => "tok_1", fetch: fetchMock });

    const result = await apiFetch<{ ok: boolean }>("/members", {
      method: "POST",
      body: { name: "Ada" },
      idempotencyKey: "key-1",
    });

    expect(result).toEqual({ ok: true });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe("/api/v1/members");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok_1");
    expect(headers.get("X-Client-Version")).toBe(CLIENT_VERSION);
    expect(headers.get("Idempotency-Key")).toBe("key-1");
    expect(init.body).toBe(JSON.stringify({ name: "Ada" }));
  });

  it("omits the bearer header when there is no signed-in session", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, {})));
    configureApiClient({ getToken: () => null, fetch: fetchMock });

    await apiFetch("/config");

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(call[1].headers).has("Authorization")).toBe(false);
  });

  it("maps 401 to sign-in with the current location as return-to", async () => {
    window.history.pushState({}, "", "/events?week=3");
    const onUnauthorized = vi.fn();
    configureApiClient({
      fetch: vi.fn(() => Promise.resolve(jsonResponse(401, { error: "unauthorized" }))),
      onUnauthorized,
    });

    await expect(apiFetch("/me")).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledWith("/events?week=3");

    onUnauthorized.mockClear();
    await expect(apiFetch("/me", { redirectOnUnauthorized: false })).rejects.toMatchObject({
      status: 401,
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("maps 426 to the refresh banner state", async () => {
    configureApiClient({
      fetch: vi.fn(() => Promise.resolve(jsonResponse(426, { error: "upgrade" }))),
    });

    await expect(apiFetch("/me")).rejects.toMatchObject({ status: 426 });
    expect(isClientOutdated()).toBe(true);
  });

  it("generates distinct idempotency keys", () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });
});
