import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../api/client";
import { registeredFrontendRoutes } from "../registry";

interface Item {
  id: string;
  category: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

const item = (over: Partial<Item> & { id: string }): Item => ({
  category: "rsvp_status",
  title: `Title ${over.id}`,
  body: `Body ${over.id}`,
  link: "/events",
  createdAt: "2027-01-01T10:00:00.000Z",
  readAt: null,
  ...over,
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubApi(items: Item[], unreadCount = items.filter((i) => i.readAt === null).length) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if (input === "/api/v1/notifications" && (init?.method ?? "GET") === "GET") {
      return Promise.resolve(json({ items, unreadCount }));
    }
    if (input === "/api/v1/notifications/read") return Promise.resolve(json({ updated: 1 }));
    return Promise.resolve(json({ error: "unexpected" }, 500));
  });
  configureApiClient({ fetch: fetchMock });
  return fetchMock;
}

function renderInbox() {
  const route = registeredFrontendRoutes().find((r) => r.path === "/inbox");
  expect(route).toBeDefined();
  const Component = route!.component;
  render(<Component />);
}

const reads = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .filter(([url]) => url === "/api/v1/notifications/read")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as unknown);

describe("inbox screen", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/inbox");
  });
  afterEach(() => {
    cleanup();
    configureApiClient({});
  });

  it("registers /inbox", () => {
    expect(registeredFrontendRoutes().map((r) => r.path)).toContain("/inbox");
  });

  it("lists notifications under NEW and EARLIER with unread dot indicators", async () => {
    stubApi([item({ id: "a" }), item({ id: "b", readAt: "2027-01-01T11:00:00.000Z" })]);
    renderInbox();
    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeTruthy();
    expect(await screen.findByText("Title a")).toBeTruthy();
    expect(screen.getByText("Body b")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "NEW (1)" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "EARLIER" })).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "Unread" })).toHaveLength(1);
    expect(screen.queryByText("Unread")).toBeNull();
  });

  it("shows an empty state", async () => {
    stubApi([]);
    renderInbox();
    expect(await screen.findByText(/nothing here yet|no notifications/i)).toBeTruthy();
  });

  it("shows an error state with retry", async () => {
    configureApiClient({ fetch: () => Promise.resolve(json({ error: "boom" }, 500)) });
    renderInbox();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try Again" })).toBeTruthy();
  });

  it("opening an item marks it read and goes to its deep link", async () => {
    const fetchMock = stubApi([item({ id: "a", link: "/events/mon-1" })]);
    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: /Title a/ }));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/events/mon-1");
    });
    expect(reads(fetchMock)).toEqual([{ ids: ["a"] }]);
  });

  it("does not call mark-read for an item that is already read", async () => {
    const fetchMock = stubApi([
      item({ id: "a", link: "/money", readAt: "2027-01-01T11:00:00.000Z" }),
    ]);
    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: /Title a/ }));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/money");
    });
    expect(reads(fetchMock)).toEqual([]);
  });

  it("never navigates to an external or malformed link", async () => {
    stubApi([item({ id: "a", link: "https://evil.example/x" }), item({ id: "b", link: "//evil" })]);
    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: /Title a/i }));
    fireEvent.click(screen.getByRole("button", { name: /Title b/i }));
    expect(window.location.pathname).toBe("/inbox");
  });

  it("mark all read sends all:true and clears the unread flags", async () => {
    const fetchMock = stubApi([item({ id: "a" }), item({ id: "b" })]);
    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: "Mark All Read" }));
    await waitFor(() => {
      expect(screen.queryAllByRole("img", { name: "Unread" })).toHaveLength(0);
    });
    expect(reads(fetchMock)).toEqual([{ all: true }]);
    expect(screen.queryByRole("button", { name: "Mark All Read" })).toBeNull();
  });

  it("enforces Title Case on notification headers and supports inline Approve/Decline for join requests", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    configureApiClient({
      fetch: vi.fn((input: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url: input });
        if (input === "/api/v1/notifications" && method === "GET") {
          return Promise.resolve(
            json({
              items: [
                item({
                  id: "jr_notif",
                  category: "admin_tasks",
                  title: "New join request",
                  body: "Sven Svensson asked to join the club.",
                  link: "/admin/approvals",
                }),
              ],
              unreadCount: 1,
            }),
          );
        }
        if (input === "/api/v1/admin/join-requests" && method === "GET") {
          return Promise.resolve(
            json({
              requests: [{ id: "jr_1", displayName: "Sven Svensson" }],
            }),
          );
        }
        if (input === "/api/v1/notifications/read") return Promise.resolve(json({ updated: 1 }));
        if (input === "/api/v1/join-requests/jr_1/approve" && method === "POST") {
          return Promise.resolve(json({ ok: true }));
        }
        return Promise.resolve(json({ error: "unexpected" }, 500));
      }),
    });

    renderInbox();
    expect(await screen.findByText("New Join Request")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Approved")).toBeTruthy();
    expect(calls.some((c) => c.url === "/api/v1/join-requests/jr_1/approve")).toBe(true);
    expect(calls.some((c) => c.url === "/api/v1/notifications/read")).toBe(true);
  });

  it("shows RSVP and Not going quick actions on new_events reminders", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    configureApiClient({
      fetch: vi.fn((input: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url: input });
        if (input === "/api/v1/notifications" && method === "GET") {
          return Promise.resolve(
            json({
              items: [
                item({
                  id: "ev_rem",
                  category: "new_events",
                  title: "Thu XD open",
                  link: "/events/thu-xd",
                }),
              ],
              unreadCount: 1,
            }),
          );
        }
        if (input === "/api/v1/notifications/read") return Promise.resolve(json({ updated: 1 }));
        if (input === "/api/v1/events/by-slug/thu-xd") {
          return Promise.resolve(json({ event: { id: "evt_thu" } }));
        }
        if (input === "/api/v1/events/evt_thu/rsvp/decline" && method === "POST") {
          return Promise.resolve(
            json({ rsvp: { id: "r1", status: "declined", tier: 2, guests: [] } }),
          );
        }
        return Promise.resolve(json({ error: "unexpected" }, 500));
      }),
    });

    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: "Not Going" }));

    expect(await screen.findByText("Not Going")).toBeTruthy();
    expect(calls.some((c) => c.url === "/api/v1/events/evt_thu/rsvp/decline")).toBe(true);
    expect(calls.some((c) => c.url === "/api/v1/notifications/read")).toBe(true);
  });
});
