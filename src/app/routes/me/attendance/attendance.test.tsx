import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../api/client";
import { registeredFrontendRoutes } from "../../registry";
import type { MemberAttendanceHistory } from "./api";

const sampleHistory: MemberAttendanceHistory = {
  items: [
    {
      eventId: "evt_2",
      title: "Friday Open",
      startsAt: "2027-04-02T18:00:00.000Z",
      endsAt: "2027-04-02T19:30:00.000Z",
      location: "Hall B",
      shareSlug: "fri-open",
      eventStatus: "closed",
      adhocFee: 100,
      kind: "admin_oneoff",
      rsvp: {
        id: "rsvp_2",
        status: "late_cancelled",
        tier: 2,
        requestedAt: "2027-04-01T10:00:00.000Z",
        confirmedAt: "2027-04-02T12:00:00.000Z",
        cancelledAt: "2027-04-02T13:00:00.000Z",
        refilled: true,
        attendance: "unknown",
        effectiveAttendance: null,
      },
      guests: [],
      ledgerEntries: [
        {
          id: "led_1",
          kind: "charge",
          reason: "adhoc",
          amountSek: 100,
          note: "",
          createdAt: "2027-04-02T12:00:00.000Z",
          guestId: null,
          reversesEntryId: null,
        },
        {
          id: "led_2",
          kind: "reversal",
          reason: "adhoc",
          amountSek: -100,
          note: "Spot refilled",
          createdAt: "2027-04-02T14:00:00.000Z",
          guestId: null,
          reversesEntryId: "led_1",
        },
      ],
      netChargedSek: 0,
      why: "Late-cancelled, spot refilled — charge reversed.",
    },
    {
      eventId: "evt_1",
      title: "Thursday XD",
      startsAt: "2027-04-01T18:00:00.000Z",
      endsAt: "2027-04-01T19:30:00.000Z",
      location: "Hall A",
      shareSlug: "thu-xd",
      eventStatus: "closed",
      adhocFee: 120,
      kind: "series",
      rsvp: {
        id: "rsvp_1",
        status: "confirmed",
        tier: 1,
        requestedAt: "2027-03-30T10:00:00.000Z",
        confirmedAt: "2027-03-30T10:00:00.000Z",
        cancelledAt: null,
        refilled: false,
        attendance: "no_show",
        effectiveAttendance: "no_show",
      },
      guests: [
        {
          id: "gst_1",
          name: "Sam Guest",
          status: "confirmed",
          tier: 3,
          requestedAt: "2027-03-30T10:01:00.000Z",
          refilled: false,
          attendance: "attended",
          effectiveAttendance: "attended",
        },
      ],
      ledgerEntries: [
        {
          id: "led_3",
          kind: "charge",
          reason: "guest",
          amountSek: 120,
          note: "",
          createdAt: "2027-04-01T12:00:00.000Z",
          guestId: "gst_1",
          reversesEntryId: null,
        },
      ],
      netChargedSek: 120,
      why: "Covered by season pass (marked no-show, no extra fee).",
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderHistory(url = "/history") {
  window.history.replaceState(null, "", url);
  const route = registeredFrontendRoutes().find((r) => r.path === "/history");
  if (!route) throw new Error("/history route not registered");
  const Page = route.component;
  return render(<Page />);
}

describe("AttendanceHistoryPage (/history, S8.2)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/history");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    configureApiClient({});
  });

  it("renders attendance & why history, links to events and back to /money, and is axe-clean", async () => {
    configureApiClient({
      fetch: vi.fn((input: RequestInfo | URL) => {
        if (typeof input === "string" && input === "/api/v1/me/attendance") {
          return Promise.resolve(json(sampleHistory));
        }
        return Promise.resolve(json({ error: "not_found" }, 404));
      }),
    });

    const { container } = renderHistory();
    await waitFor(() => {
      expect(screen.getByText("Friday Open")).toBeTruthy();
    });

    expect(screen.getByText("Thursday XD")).toBeTruthy();
    expect(screen.getByText("Late-cancelled, spot refilled — charge reversed.")).toBeTruthy();
    expect(screen.getByText("Covered by season pass (marked no-show, no extra fee).")).toBeTruthy();
    expect(screen.getByText(/Sam Guest/)).toBeTruthy();

    // Links to the event pages
    const thuLink = screen.getByRole("link", { name: "Thursday XD" });
    expect(thuLink.getAttribute("href")).toBe("/events/thu-xd");

    // Every event with ledger entries links back to /money
    const moneyLinks = screen.getAllByRole("link", { name: /money/i });
    expect(moneyLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of moneyLinks) {
      expect(link.getAttribute("href")).toBe("/money");
    }

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it("highlights the linked event when ?eventId= is present", async () => {
    configureApiClient({
      fetch: vi.fn(() => Promise.resolve(json(sampleHistory))),
    });

    renderHistory("/history?eventId=evt_1");
    await waitFor(() => {
      expect(screen.getByText("Thursday XD")).toBeTruthy();
    });

    const highlighted = document.querySelector("[data-highlighted='true']");
    expect(highlighted).toBeTruthy();
    expect(highlighted?.textContent).toContain("Thursday XD");
  });

  it("shows empty state when there is no history and error state with retry on failure", async () => {
    let fail = true;
    configureApiClient({
      fetch: vi.fn(() =>
        Promise.resolve(fail ? json({ error: "boom" }, 500) : json({ items: [] })),
      ),
    });

    renderHistory();
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load your attendance history/i)).toBeTruthy();
    });

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => {
      expect(screen.getByText(/No attendance history yet/i)).toBeTruthy();
    });
  });
});
