import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../../api/client";
import { ToastProvider } from "../../../../components/ui";
import { FeatureFlagsProvider } from "../../../../lib/flags";
import { registeredFrontendRoutes } from "../../../registry";
import { SchedulePage } from "./SchedulePage";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A bare object is a 200 body; `{ status, body }` sets the status. */
type Reply = object;

const series = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  termId: "t1",
  name: "Sunday XD",
  weekday: 7,
  startTime: "19:00",
  skipDates: ["2027-04-04"],
  skipDatesLocked: false,
  ...over,
});

const ev = (id: string, startsAt: string, over: Record<string, unknown> = {}) => ({
  id,
  startsAt,
  endsAt: startsAt,
  rsvpCloseAt: startsAt,
  location: "Hall A",
  capacity: 16,
  maxGuestsPerMember: 1,
  status: "scheduled",
  ...over,
});

const listing = (over: { series?: Record<string, unknown>; occurrences?: unknown[] } = {}) => ({
  series: series(over.series),
  term: { id: "t1", name: "Spring", status: "draft", startsOn: "2027-03-01", endsOn: "2027-04-30" },
  occurrences: over.occurrences ?? [
    { date: "2027-03-21", skipped: false, event: ev("e1", "2027-03-21T18:00:00.000Z") },
    { date: "2027-03-28", skipped: false, event: null },
    { date: "2027-04-04", skipped: true, event: null },
  ],
});

let calls: Call[];

/** Each key maps to one reply or a queue of replies (consumed in order, last one sticks). */
function stub(routes: Record<string, Reply | Reply[]>) {
  calls = [];
  const queues = new Map<string, Reply[]>(
    Object.entries(routes).map(([k, v]): [string, Reply[]] => [
      k,
      Array.isArray(v) ? (v as Reply[]) : [v],
    ]),
  );
  configureApiClient({
    fetch: vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = input.replace("/api/v1", "");
      calls.push({
        method,
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const queue = queues.get(`${method} ${path}`);
      if (!queue) return Promise.resolve(new Response("no stub", { status: 500 }));
      const reply = (queue.length > 1 ? queue.shift() : queue[0]) ?? {};
      const { status, body } =
        "status" in reply
          ? (reply as { status: number; body: unknown })
          : { status: 200, body: reply };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  });
}

const renderPage = (flags: Record<string, boolean> = { events: true }) =>
  render(
    <FeatureFlagsProvider flags={flags}>
      <ToastProvider>
        <SchedulePage />
      </ToastProvider>
    </FeatureFlagsProvider>,
  );

const sent = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

beforeEach(() => {
  window.history.pushState({}, "", "/admin/terms/series/s1/schedule");
});

afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("schedule route", () => {
  it("is registered", () => {
    expect(registeredFrontendRoutes().map((r) => r.path)).toContain(
      "/admin/terms/series/:id/schedule",
    );
  });

  it("stays dark while the events flag is off", () => {
    stub({});
    renderPage({});
    expect(screen.getByText(/not available yet/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

describe("SchedulePage", () => {
  it("lists occurrences in Stockholm time with their state", async () => {
    stub({ "GET /series/s1/occurrences": listing() });
    renderPage();
    expect(await screen.findByRole("heading", { name: /Sunday XD Schedule/ })).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText(/19:00/)).toBeTruthy();
    expect(within(items[0]!).getByText("Scheduled")).toBeTruthy();
    expect(within(items[1]!).getByText("Not Generated")).toBeTruthy();
    expect(within(items[2]!).getByText("Skipped")).toBeTruthy();
  });

  it("generates events and reloads", async () => {
    stub({
      "GET /series/s1/occurrences": listing(),
      "POST /series/s1/generate-events": { created: 1, events: [] },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Generate Events" }));
    await waitFor(() => {
      expect(sent("POST", "/series/s1/generate-events")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(sent("GET", "/series/s1/occurrences").length).toBeGreaterThan(1);
    });
    expect(await screen.findByText(/1 event created/i)).toBeTruthy();
  });

  it("saves skip-dates from the switches", async () => {
    stub({
      "GET /series/s1/occurrences": listing(),
      "PUT /series/s1/skip-dates": { skipDates: ["2027-03-28", "2027-04-04"] },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("switch", { name: /Skip .*28/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save Skip-Dates" }));
    await waitFor(() => {
      expect(sent("PUT", "/series/s1/skip-dates")).toHaveLength(1);
    });
    expect(sent("PUT", "/series/s1/skip-dates")[0]!.body).toEqual({
      skipDates: ["2027-03-28", "2027-04-04"],
    });
  });

  it("hides Save Skip-Dates while locked and unmodified, and overrides via confirmation sheet", async () => {
    stub({
      "GET /series/s1/occurrences": listing({ series: { skipDatesLocked: true } }),
      "PUT /series/s1/skip-dates": [
        { status: 409, body: { error: "skip_dates_locked" } },
        { skipDates: ["2027-04-04"] },
      ],
    });
    renderPage();
    expect(await screen.findByText(/locked because passes are on sale/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save Skip-Dates" })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: /Skip .*28/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save Skip-Dates" }));

    const confirm = await screen.findByRole("dialog", { name: "Override Locked Skip-Dates?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Save Anyway" }));
    await waitFor(() => {
      expect(sent("PUT", "/series/s1/skip-dates")).toHaveLength(2);
    });
    expect(sent("PUT", "/series/s1/skip-dates")[1]!.body).toMatchObject({ overrideLock: true });
  });

  it("edits an occurrence and asks before saving a capacity below passes sold", async () => {
    stub({
      "GET /series/s1/occurrences": listing(),
      "PATCH /series/s1/occurrences/e1": [
        { status: 409, body: { error: "cap_below_passes_sold", passCap: 4, passesSold: 5 } },
        { event: ev("e1", "2027-03-21T18:00:00.000Z", { capacity: 4 }) },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Edit .*21/ }));
    const dialog = screen.getByRole("dialog", { name: "Edit Occurrence" });
    fireEvent.change(within(dialog).getByLabelText("Capacity"), { target: { value: "4" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    const confirm = await screen.findByRole("dialog", { name: "Override Pass Cap?" });
    expect(confirm.textContent).toMatch(/4.*5 passes/);
    expect(sent("PATCH", "/series/s1/occurrences/e1")[0]!.body).toEqual({ capacity: 4 });
    fireEvent.click(within(confirm).getByRole("button", { name: "Save Anyway" }));
    await waitFor(() => {
      expect(sent("PATCH", "/series/s1/occurrences/e1")).toHaveLength(2);
    });
    expect(sent("PATCH", "/series/s1/occurrences/e1")[1]!.body).toEqual({
      capacity: 4,
      overrideCapBelowSold: true,
    });
  });
});
