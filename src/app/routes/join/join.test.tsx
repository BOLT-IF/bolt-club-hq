import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureApiClient } from "../../api/client";
import { saveIntent } from "../../auth/intent";
import { ToastProvider } from "../../components/ui/Toast";
import { registeredFrontendRoutes, resolveRoute } from "../registry";
import { peekJoinRsvpIntent } from "./joinIntent";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const pending = { id: "m1", role: "member", status: "pending", seriesIds: [] };
const active = { ...pending, status: "active" };

type Handler = (method: string, path: string, body: unknown) => Response;

function renderAt(path: string, handler: Handler) {
  window.history.pushState({}, "", path);
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  configureApiClient({
    onUnauthorized: () => undefined,
    fetch: (input, init) => {
      const p = input.replace("/api/v1", "");
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: p, body });
      return Promise.resolve(handler(method, p, body));
    },
  });
  const Page = resolveRoute(window.location.pathname)?.route.component;
  if (!Page) throw new Error(`no route for ${path}`);
  render(
    <ToastProvider>
      <Page />
    </ToastProvider>,
  );
  return calls;
}

const waitingHandler =
  (extra: Handler = () => json(500, {})): Handler =>
  (method, path, body) => {
    if (path === "/me") return json(200, pending);
    if (method === "POST" && path === "/join-requests")
      return json(201, { request: { id: "jr1", via: "invite", createdAt: "2027-03-01T09:00:00Z" } });
    if (path === "/join-requests/mine")
      return json(200, {
        status: "pending",
        request: { id: "jr1", via: "invite", createdAt: "2027-03-01T09:00:00Z" },
      });
    return extra(method, path, body);
  };

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("join flow", () => {
  it("registers /join, invite, event and series link routes", () => {
    const paths = registeredFrontendRoutes().map((r) => r.path);
    expect(paths).toEqual(
      expect.arrayContaining(["/join", "/join/:token", "/join/event/:slug", "/join/series/:slug"]),
    );
  });

  it("an invite link files a request and shows the waiting screen", async () => {
    const calls = renderAt("/join/tok123", waitingHandler());
    expect(await screen.findByRole("heading", { name: /waiting for approval/i })).toBeTruthy();
    expect(calls).toContainEqual({
      method: "POST",
      path: "/join-requests",
      body: { via: "invite", token: "tok123" },
    });
    // Pending members get no member directory, attendees or ledger calls from this screen.
    expect(calls.some((c) => /^\/(members|events|me\/ledger)/.test(c.path))).toBe(false);
  });

  it("a revoked or expired invite says so in plain words", async () => {
    renderAt("/join/old", (method, path) => {
      if (path === "/me") return json(200, pending);
      if (method === "POST") return json(410, { error: "invite_expired" });
      return json(200, { status: "pending", request: null });
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/invite link has expired/i)).toBeTruthy();
  });

  it("an event link keeps the RSVP from sign-in so approval can complete it", async () => {
    saveIntent({ returnTo: "/events/eventslug1", rsvp: { eventSlug: "eventslug1", response: "in" } });
    const calls = renderAt("/join/event/eventslug1", waitingHandler());
    expect(await screen.findByRole("heading", { name: /waiting for approval/i })).toBeTruthy();
    expect(calls).toContainEqual({
      method: "POST",
      path: "/join-requests",
      body: { via: "event_link", slug: "eventslug1" },
    });
    expect(peekJoinRsvpIntent()?.eventSlug).toBe("eventslug1");
    expect(screen.getByText(/your RSVP will be sent/i)).toBeTruthy();
  });

  it("a series link files a series_link request", async () => {
    const calls = renderAt("/join/series/seriesslug", waitingHandler());
    await screen.findByRole("heading", { name: /waiting for approval/i });
    expect(calls).toContainEqual({
      method: "POST",
      path: "/join-requests",
      body: { via: "series_link", slug: "seriesslug" },
    });
  });

  it("after approval, opening the app completes the stored RSVP and says so", async () => {
    window.localStorage.setItem(
      "bcq.join-rsvp-intent",
      JSON.stringify({ eventSlug: "eventslug1", idempotencyKey: "k-1", savedAt: Date.now() }),
    );
    const calls = renderAt("/join", (method, path) => {
      if (path === "/me") return json(200, active);
      if (path === "/events/by-slug/eventslug1")
        return json(200, { event: { id: "evt_1", slug: "eventslug1" }, viewer: {} });
      if (method === "GET" && path === "/events/evt_1/rsvp") return json(200, { rsvp: null });
      if (method === "PUT")
        return json(200, { rsvp: { id: "r1", status: "requested", tier: 2, guests: [] } });
      return json(500, {});
    });
    expect(await screen.findByRole("heading", { name: /you're in/i })).toBeTruthy();
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    });
    expect(await screen.findByText(/RSVP has been sent/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /open the event/i }).getAttribute("href")).toBe(
      "/events/eventslug1",
    );
  });

  it("an active member opening an invite link files nothing", async () => {
    const calls = renderAt("/join/tok123", (_m, path) =>
      path === "/me" ? json(200, active) : json(500, {}),
    );
    expect(await screen.findByRole("heading", { name: /you're in/i })).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});
