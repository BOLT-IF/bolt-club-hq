import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureApiClient } from "../../api/client";
import type { EventDetail, EventViewer } from "../../api/events";
import { registeredFrontendRoutes } from "../registry";
import { EventDetailPage } from "./EventDetailPage";
import { EventListPage } from "./EventListPage";
import { clearSlots, registerSlot } from "./slots";

const detail = (over: Partial<EventDetail> = {}): EventDetail => ({
  id: "evt_1",
  slug: "k3f9xq2m",
  seriesId: "ser_1",
  kind: "series",
  title: "Thu Mixed Doubles",
  format: "XD",
  startsAt: "2027-03-11T18:00:00.000Z",
  endsAt: "2027-03-11T19:30:00.000Z",
  location: "Hall X",
  capacity: 12,
  adhocFee: 0,
  maxGuestsPerMember: 1,
  rsvpCloseAt: "2027-03-10T18:00:00.000Z",
  allocationMode: "tiered",
  status: "scheduled",
  readOnly: false,
  ...over,
});

function stubApi(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = [];
  configureApiClient({
    fetch: (input) => {
      calls.push(input);
      const hit = routes[input.replace("/api/v1", "")];
      return Promise.resolve(
        new Response(JSON.stringify(hit?.body ?? { error: "not_found" }), {
          status: hit?.status ?? (hit ? 200 : 404),
        }),
      );
    },
  });
  return calls;
}

beforeEach(() => {
  window.history.replaceState({}, "", "/events/k3f9xq2m");
});

afterEach(() => {
  cleanup();
  clearSlots();
  configureApiClient({});
});

describe("events routes registration", () => {
  it("registers the list and the detail pattern", () => {
    const paths = registeredFrontendRoutes().map((r) => r.path);
    expect(paths).toContain("/events");
    expect(paths).toContain("/events/:slug");
  });
});

describe("EventListPage", () => {
  it("lists upcoming events as links to their page", async () => {
    stubApi({
      "/events": {
        body: { events: [detail(), detail({ id: "evt_2", slug: "zz9y8x7w", title: "Sat Open" })] },
      },
    });
    render(<EventListPage />);
    const link = await screen.findByRole("link", { name: /Thu Mixed Doubles/ });
    expect(link.getAttribute("href")).toBe("/events/k3f9xq2m");
    expect(screen.getByRole("link", { name: /Sat Open/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "New event" }).getAttribute("href")).toBe(
      "/events/new",
    );
  });

  it("shows an empty state, and an error with retry", async () => {
    stubApi({ "/events": { body: { events: [] } } });
    render(<EventListPage />);
    expect(await screen.findByText(/no upcoming events/i)).toBeTruthy();
    cleanup();

    stubApi({ "/events": { status: 500, body: { error: "boom" } } });
    render(<EventListPage />);
    expect(await screen.findByRole("button", { name: /try again/i })).toBeTruthy();
  });
});

describe("EventDetailPage", () => {
  const viewer = (over: Partial<EventViewer> = {}): EventViewer => ({
    canManage: false,
    canSeeAttendees: true,
    ...over,
  });

  it("shows the event, and renders each registered slot", async () => {
    stubApi({
      "/events/by-slug/k3f9xq2m": {
        body: { event: detail(), viewer: viewer({ canManage: true }) },
      },
    });
    registerSlot("RsvpSlot", () => <p>rsvp panel</p>);
    registerSlot("ShareSlot", () => <p>share button</p>);
    registerSlot("OrganizerToolsSlot", () => <p>organizer tools</p>);
    registerSlot("AttendeesSlot", () => <p>attendee list</p>);

    render(<EventDetailPage />);
    expect(await screen.findByRole("heading", { name: "Thu Mixed Doubles" })).toBeTruthy();
    expect(screen.getByText(/Hall X/)).toBeTruthy();
    for (const text of ["rsvp panel", "share button", "organizer tools", "attendee list"]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
  });

  it("hides organizer tools from a plain member", async () => {
    stubApi({ "/events/by-slug/k3f9xq2m": { body: { event: detail(), viewer: viewer() } } });
    registerSlot("OrganizerToolsSlot", () => <p>organizer tools</p>);
    registerSlot("RsvpSlot", () => <p>rsvp panel</p>);
    render(<EventDetailPage />);
    await screen.findByText("rsvp panel");
    expect(screen.queryByText("organizer tools")).toBeNull();
  });

  it("a pending member sees no attendees, even if the slot is filled", async () => {
    stubApi({
      "/events/by-slug/k3f9xq2m": {
        body: { event: detail(), viewer: viewer({ canSeeAttendees: false }) },
      },
    });
    registerSlot("AttendeesSlot", () => <p>attendee list</p>);
    registerSlot("RsvpSlot", () => <p>rsvp panel</p>);
    render(<EventDetailPage />);
    await screen.findByText("rsvp panel");
    expect(screen.queryByText("attendee list")).toBeNull();
  });

  it("marks a past event read-only and hides organizer tools", async () => {
    stubApi({
      "/events/by-slug/k3f9xq2m": {
        body: {
          event: detail({ readOnly: true, status: "completed" }),
          viewer: viewer({ canManage: true }),
        },
      },
    });
    registerSlot("OrganizerToolsSlot", () => <p>organizer tools</p>);
    render(<EventDetailPage />);
    expect(await screen.findByText(/past event/i)).toBeTruthy();
    expect(screen.queryByText("organizer tools")).toBeNull();
  });

  it("shows a friendly not-found for an unknown slug, and a blocked state for a 403", async () => {
    stubApi({});
    render(<EventDetailPage />);
    expect(await screen.findByText(/couldn.t find that event/i)).toBeTruthy();
    cleanup();

    stubApi({ "/events/by-slug/k3f9xq2m": { status: 403, body: { error: "forbidden" } } });
    render(<EventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText(/approved members/i)).toBeTruthy();
    });
    expect(screen.getByRole("link", { name: "Request to join" }).getAttribute("href")).toBe(
      "/join/event/k3f9xq2m",
    );
  });
});
