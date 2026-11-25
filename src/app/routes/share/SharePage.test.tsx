// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../api/client";
import { peekIntent, saveIntent, takeIntent } from "../../auth/intent";
import { ToastProvider } from "../../components/ui/Toast";
import { ShareEventPage } from "./SharePage";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => {
      data.clear();
    },
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("ShareEventPage (S7.1)", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  });

  afterEach(() => {
    cleanup();
    configureApiClient({});
    takeIntent();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  it("saves sign-in intent when logged out and sends user to sign-in", async () => {
    window.history.replaceState(null, "", "/e/k3f9xq2m");
    configureApiClient({
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    });

    render(<ShareEventPage />);
    const btn = await screen.findByRole("button", { name: /sign in/i });
    fireEvent.click(btn);

    const saved = peekIntent();
    expect(saved?.returnTo).toBe("/e/k3f9xq2m");
    expect(saved?.rsvp).toEqual({ eventSlug: "k3f9xq2m", response: "in" });
  });

  it("completes saved RSVP intent automatically after returning from sign-in", async () => {
    window.history.replaceState(null, "", "/e/k3f9xq2m");
    saveIntent({ returnTo: "/e/k3f9xq2m", rsvp: { eventSlug: "k3f9xq2m", response: "in" } });

    const calls: Array<{ url: string; method: string }> = [];
    configureApiClient({
      fetch: (url, init) => {
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.endsWith("/events/by-slug/k3f9xq2m")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                event: {
                  id: "evt_1",
                  slug: "k3f9xq2m",
                  seriesId: null,
                  kind: "admin_oneoff",
                  title: "Thu Mixed Doubles",
                  format: "XD",
                  startsAt: "2027-03-11T18:00:00.000Z",
                  endsAt: "2027-03-11T19:30:00.000Z",
                  location: "Hall X",
                  capacity: 16,
                  adhocFee: 50,
                  maxGuestsPerMember: 1,
                  rsvpCloseAt: "2027-03-11T17:00:00.000Z",
                  allocationMode: "tiered",
                  status: "scheduled",
                  readOnly: false,
                },
                viewer: { canManage: false, canSeeAttendees: true },
              }),
              { status: 200 },
            ),
          );
        }
        if (url.endsWith("/events/evt_1/rsvp") && init?.method === "PUT") {
          return Promise.resolve(
            new Response(JSON.stringify({ rsvp: { id: "r_1", status: "requested", guests: [] } }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ rsvp: { id: "r_1", status: "requested", guests: [] } }), {
            status: 200,
          }),
        );
      },
    });

    render(
      <ToastProvider>
        <ShareEventPage />
      </ToastProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Thu Mixed Doubles" })).toBeTruthy();
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/events/evt_1/rsvp") && c.method === "PUT")).toBe(
        true,
      );
    });
    expect(peekIntent()).toBeNull();
  });

  it("offers Request to join to a signed-in non-member (403)", async () => {
    window.history.replaceState(null, "", "/e/k3f9xq2m");
    configureApiClient({
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })),
    });

    render(<ShareEventPage />);
    const link = await screen.findByRole("link", { name: /request to join/i });
    expect(link.getAttribute("href")).toBe("/join/event/k3f9xq2m");
  });

  it("shows a friendly 404 when the slug is unknown", async () => {
    window.history.replaceState(null, "", "/e/missing99");
    configureApiClient({
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 })),
    });

    render(<ShareEventPage />);
    expect(await screen.findByText(/couldn't find that event/i)).toBeTruthy();
  });
});
