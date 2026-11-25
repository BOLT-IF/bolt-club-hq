import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../api/client";
import { ToastProvider } from "../../../components/ui";
import { FeatureFlagsProvider } from "../../../lib/flags";
import { registeredFrontendRoutes } from "../../registry";
import { SeriesPage } from "./SeriesPage";
import { TermPage } from "./TermPage";
import { TermsPage } from "./TermsPage";

/** Minimal stand-in for user-event (not installed; no dependency changes allowed). */
const userEvent = {
  setup: () => ({
    type: (el: HTMLElement, value: string) => {
      fireEvent.change(el, { target: { value } });
      return Promise.resolve();
    },
    clear: (el: HTMLElement) => {
      fireEvent.change(el, { target: { value: "" } });
      return Promise.resolve();
    },
    selectOptions: (el: HTMLElement, value: string) => {
      fireEvent.change(el, { target: { value } });
      return Promise.resolve();
    },
    click: (el: HTMLElement) => {
      fireEvent.click(el);
      return Promise.resolve();
    },
  }),
};

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

const term = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "Spring 2027",
  startsOn: "2027-01-11",
  endsOn: "2027-06-24",
  status: "draft",
  clonedFromTermId: null,
  seriesCount: 1,
  ...over,
});

const seriesRow = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  termId: "t1",
  name: "Thursday XD",
  format: "XD",
  level: null,
  weekday: 4,
  startTime: "19:00",
  durationMin: 90,
  location: "Hall A",
  capacity: 16,
  passPrice: 1800,
  discountedPassPrice: null,
  adhocFee: 120,
  maxGuestsDefault: 1,
  rsvpCloseOffsetMin: 1440,
  shareSlug: "abcdefgh12",
  skipDates: [],
  skipDatesLocked: false,
  passCap: 16,
  captains: [],
  ...over,
});

let calls: Call[];

function stub(routes: Record<string, unknown>) {
  calls = [];
  configureApiClient({
    fetch: vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = input.replace("/api/v1", "");
      calls.push({
        method,
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: new Headers(init?.headers),
      });
      const key = `${method} ${path}`;
      if (!(key in routes))
        return Promise.resolve(new Response(`no stub for ${key}`, { status: 500 }));
      const value = routes[key];
      return Promise.resolve(
        value === null
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify(value), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      );
    }),
  });
}

function renderPage(ui: React.ReactElement, flags: Record<string, boolean> = { events: true }) {
  return render(
    <FeatureFlagsProvider flags={flags}>
      <ToastProvider>{ui}</ToastProvider>
    </FeatureFlagsProvider>,
  );
}

beforeEach(() => {
  window.history.pushState({}, "", "/admin/terms");
});

afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("route registration", () => {
  it("registers the admin terms pages", () => {
    const paths = registeredFrontendRoutes().map((r) => r.path);
    expect(paths).toEqual(
      expect.arrayContaining(["/admin/terms", "/admin/terms/:id", "/admin/terms/series/:id"]),
    );
  });
});

describe("TermsPage", () => {
  it("is unavailable while the events flag is off", () => {
    stub({});
    renderPage(<TermsPage />, {});
    expect(screen.getByText(/not available yet/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("lists terms with a status chip, dates and a link to each", async () => {
    stub({
      "GET /terms": {
        terms: [term(), term({ id: "t0", name: "Autumn 2026", status: "closed", seriesCount: 3 })],
      },
    });
    renderPage(<TermsPage />);
    const link = await screen.findByRole("link", { name: "Spring 2027" });
    expect(link.getAttribute("href")).toBe("/admin/terms/t1");
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByText("Closed")).toBeTruthy();
    expect(screen.getByText(/3 series/)).toBeTruthy();
  });

  it("shows an empty state, and an error with a retry", async () => {
    stub({ "GET /terms": { terms: [] } });
    renderPage(<TermsPage />);
    expect(await screen.findByText(/no terms yet/i)).toBeTruthy();
    cleanup();

    configureApiClient({ fetch: () => Promise.resolve(new Response("{}", { status: 500 })) });
    renderPage(<TermsPage />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("creates a term from the labelled form and reloads the list", async () => {
    const user = userEvent.setup();
    stub({
      "GET /terms": { terms: [] },
      "POST /terms": { term: term() },
    });
    renderPage(<TermsPage />);
    await screen.findByText(/no terms yet/i);

    await user.type(screen.getByLabelText("Name"), "Spring 2027");
    await user.type(screen.getByLabelText("Starts on"), "2027-01-11");
    await user.type(screen.getByLabelText("Ends on"), "2027-06-24");
    await user.click(screen.getByRole("button", { name: "Create term" }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.path === "/terms")).toBe(true);
    });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      name: "Spring 2027",
      startsOn: "2027-01-11",
      endsOn: "2027-06-24",
    });
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "GET" && c.path === "/terms").length).toBeGreaterThan(
        1,
      );
    });
  });

  it("clones a term with an Idempotency-Key and opens the new term", async () => {
    const user = userEvent.setup();
    stub({
      "GET /terms": { terms: [term({ status: "active" })] },
      "POST /terms/t1/clone": { term: term({ id: "t2", name: "Autumn 2027" }), series: [] },
    });
    renderPage(<TermsPage />);
    await user.click(await screen.findByRole("button", { name: "Clone Spring 2027" }));

    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Autumn 2027");
    await user.type(within(dialog).getByLabelText("Starts on"), "2027-07-05");
    await user.type(within(dialog).getByLabelText("Ends on"), "2027-12-20");
    await user.click(within(dialog).getByRole("button", { name: "Clone term" }));

    await waitFor(() => {
      expect(calls.some((c) => c.path === "/terms/t1/clone")).toBe(true);
    });
    const clone = calls.find((c) => c.path === "/terms/t1/clone")!;
    expect(clone.headers.get("Idempotency-Key")).toBeTruthy();
    expect(clone.body).toEqual({
      name: "Autumn 2027",
      startsOn: "2027-07-05",
      endsOn: "2027-12-20",
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/admin/terms/t2");
    });
  });
});

describe("TermPage", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/admin/terms/t1");
  });

  it("shows the term, its series and a way to add one", async () => {
    stub({ "GET /terms/t1": { term: term(), series: [seriesRow()] } });
    renderPage(<TermPage />);
    expect(await screen.findByRole("heading", { name: "Spring 2027" })).toBeTruthy();
    const link = screen.getByRole("link", { name: /Thursday XD/ });
    expect(link.getAttribute("href")).toBe("/admin/terms/series/s1");
    expect(screen.getByRole("heading", { name: "Add a series" })).toBeTruthy();
  });

  it("offers only the next status, and warns that opening locks skip-dates", async () => {
    const user = userEvent.setup();
    stub({
      "GET /terms/t1": { term: term(), series: [] },
      "PATCH /terms/t1": { term: term({ status: "open_for_passes" }) },
    });
    renderPage(<TermPage />);
    await user.click(await screen.findByRole("button", { name: "Move to Open for passes" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/skip-dates/i)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Open for passes" }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "PATCH")).toBe(true);
    });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ status: "open_for_passes" });
  });

  it("has no next step once the term is closed", async () => {
    stub({ "GET /terms/t1": { term: term({ status: "closed" }), series: [] } });
    renderPage(<TermPage />);
    await screen.findByRole("heading", { name: "Spring 2027" });
    expect(screen.queryByRole("button", { name: /^Move to/ })).toBeNull();
  });

  it("adds a series with whole-kronor prices", async () => {
    const user = userEvent.setup();
    stub({
      "GET /terms/t1": { term: term(), series: [] },
      "POST /series": { series: seriesRow() },
    });
    renderPage(<TermPage />);
    await screen.findByRole("heading", { name: "Add a series" });

    await user.type(screen.getByLabelText("Name"), "Thursday XD");
    await user.selectOptions(screen.getByLabelText("Format"), "XD");
    await user.selectOptions(screen.getByLabelText("Weekday"), "4");
    await user.type(screen.getByLabelText("Start time"), "19:00");
    await user.type(screen.getByLabelText("Duration (minutes)"), "90");
    await user.type(screen.getByLabelText("Capacity"), "16");
    await user.type(screen.getByLabelText("Pass price (kr)"), "1800");
    await user.type(screen.getByLabelText("Drop-in fee (kr)"), "120");
    await user.click(screen.getByRole("button", { name: "Add series" }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.path === "/series")).toBe(true);
    });
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({
      termId: "t1",
      name: "Thursday XD",
      format: "XD",
      weekday: 4,
      startTime: "19:00",
      durationMin: 90,
      capacity: 16,
      passPrice: 1800,
      adhocFee: 120,
    });
  });
});

describe("SeriesPage", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/admin/terms/series/s1");
  });

  const base = {
    "GET /series/s1": {
      series: seriesRow({ captains: [{ id: "m1", displayName: "Ada Captain" }] }),
    },
    "GET /series/captain-candidates": {
      members: [
        { id: "m1", displayName: "Ada Captain" },
        { id: "m2", displayName: "Bo Player" },
      ],
    },
  };

  it("shows the pass cap and the current captains", async () => {
    stub(base);
    renderPage(<SeriesPage />);
    expect(await screen.findByRole("heading", { name: "Thursday XD" })).toBeTruthy();
    expect(screen.getByText(/pass cap/i).textContent).toContain("16");
    expect(
      screen.getByRole("link", { name: "Schedule and occurrences" }).getAttribute("href"),
    ).toBe("/admin/terms/series/s1/schedule");
    // The candidate list loads separately from the series, so wait for it.
    const captains = await screen.findByRole("group", { name: "Captains" });
    const ada = within(captains).getByRole<HTMLInputElement>("checkbox", { name: "Ada Captain" });
    expect(ada.checked).toBe(true);
    expect(
      within(captains).getByRole<HTMLInputElement>("checkbox", { name: "Bo Player" }).checked,
    ).toBe(false);
  });

  it("saves the chosen captains as a full replacement", async () => {
    const user = userEvent.setup();
    stub({
      ...base,
      "PUT /series/s1/captains": { series: seriesRow() },
    });
    renderPage(<SeriesPage />);
    const captains = await screen.findByRole("group", { name: "Captains" });
    await user.click(within(captains).getByRole("checkbox", { name: "Bo Player" }));
    await user.click(screen.getByRole("button", { name: "Save captains" }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "PUT")).toBe(true);
    });
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ memberIds: ["m1", "m2"] });
  });

  it("explains a blocked capacity change and lets an admin override it", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    stub(base);
    configureApiClient({
      fetch: (input: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const path = input.replace("/api/v1", "");
        calls.push({
          method,
          path,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          headers: new Headers(init?.headers),
        });
        const json = (status: number, body: unknown) =>
          Promise.resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            }),
          );
        if (method === "GET" && path === "/series/s1") return json(200, base["GET /series/s1"]);
        if (method === "GET") return json(200, base["GET /series/captain-candidates"]);
        attempt += 1;
        return attempt === 1
          ? json(409, { error: "cap_below_passes_sold", passCap: 8, passesSold: 12 })
          : json(200, { series: seriesRow({ capacity: 8, passCap: 8 }) });
      },
    });
    renderPage(<SeriesPage />);
    const capacity = await screen.findByLabelText("Capacity");
    await user.clear(capacity);
    await user.type(capacity, "8");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/12 passes/);
    await user.click(screen.getByRole("button", { name: "Save anyway" }));

    await waitFor(() => {
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
    });
    expect(calls.filter((c) => c.method === "PATCH")[1]!.body).toMatchObject({
      capacity: 8,
      overrideCapBelowSold: true,
    });
  });

  it("sets discounted pass price and eligible members while creating a series", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/admin/terms/t1");
    stub({
      "GET /terms/t1": { term: term(), series: [seriesRow()] },
      "GET /series/captain-candidates": {
        members: [
          { id: "m1", displayName: "Ada Lovelace" },
          { id: "m2", displayName: "Bo Player" },
        ],
      },
      "POST /series": { series: seriesRow({ discountedPassPrice: 750 }) },
    });
    renderPage(<TermPage />);
    await screen.findByText("Thursday XD");

    await user.type(screen.getByLabelText("Name"), "Sunday Open");
    await user.type(screen.getByLabelText("Start time"), "18:00");
    await user.type(screen.getByLabelText("Duration (minutes)"), "120");
    await user.type(screen.getByLabelText("Capacity"), "16");
    await user.type(screen.getByLabelText("Pass price (kr)"), "1000");
    await user.type(screen.getByLabelText("Discounted pass price (kr, optional)"), "750");
    await user.type(screen.getByLabelText("Drop-in fee (kr)"), "100");

    const eligibleGroup = screen.getByRole("group", { name: "Eligible for discounted rate" });
    await user.click(within(eligibleGroup).getByLabelText("Ada Lovelace"));
    await user.click(screen.getByRole("button", { name: "Add series" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.path === "/series");
      expect(post?.body).toMatchObject({
        passPrice: 1000,
        discountedPassPrice: 750,
        discountEligibleIds: ["m1"],
      });
    });
  });
});
