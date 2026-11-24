import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../api/client";
import { registeredFrontendRoutes } from "../../registry";

interface Prefs {
  globalMute: boolean;
  categories: { category: string; muted: boolean }[];
}

const initial = (over: Partial<Prefs> = {}): Prefs => ({
  globalMute: false,
  categories: [
    { category: "rsvp_status", muted: false },
    { category: "event_changes", muted: false },
    { category: "new_events", muted: true },
    { category: "payment_due", muted: false },
    { category: "payment_status", muted: false },
    { category: "polls", muted: false },
    { category: "announcements", muted: false },
  ],
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stubApi(prefs: Prefs, putStatus = 200) {
  const puts: unknown[] = [];
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if (input !== "/api/v1/notifications/prefs") return Promise.resolve(json({}, 500));
    if ((init?.method ?? "GET") === "GET") return Promise.resolve(json(prefs));
    puts.push(JSON.parse(init?.body as string));
    return Promise.resolve(json(prefs, putStatus));
  });
  configureApiClient({ fetch: fetchMock });
  return puts;
}

function renderPage() {
  const route = registeredFrontendRoutes().find((r) => r.path === "/settings/notifications");
  expect(route).toBeDefined();
  const Component = route!.component;
  render(<Component />);
}

describe("notification settings", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/settings/notifications");
  });
  afterEach(() => {
    cleanup();
    configureApiClient({});
  });

  it("registers /settings/notifications", () => {
    expect(registeredFrontendRoutes().map((r) => r.path)).toContain("/settings/notifications");
  });

  it("shows a labelled switch per category, on unless muted", async () => {
    stubApi(initial());
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: /notifications/i })).toBeTruthy();
    const rsvp = await screen.findByRole<HTMLInputElement>("switch", { name: /RSVP/i });
    expect(rsvp.checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("switch", { name: /new events/i }).checked).toBe(
      false,
    );
    expect(screen.getAllByRole("switch").length).toBe(8); // 7 categories + mute-all
  });

  it("turning a category off saves it as muted", async () => {
    const puts = stubApi(initial());
    renderPage();
    fireEvent.click(await screen.findByRole("switch", { name: /payment due/i }));
    await waitFor(() => {
      expect(puts).toEqual([{ categories: { payment_due: true } }]);
    });
  });

  it("the mute-all switch saves globalMute and explains that the inbox still fills", async () => {
    const puts = stubApi(initial({ globalMute: true }));
    renderPage();
    const all = await screen.findByRole<HTMLInputElement>("switch", { name: /mute all/i });
    expect(all.checked).toBe(true);
    expect(screen.getByText(/inbox/i)).toBeTruthy();
    fireEvent.click(all);
    await waitFor(() => {
      expect(puts).toEqual([{ globalMute: false }]);
    });
  });

  it("reverts the switch and shows an error when saving fails", async () => {
    stubApi(initial(), 500);
    renderPage();
    const rsvp = await screen.findByRole<HTMLInputElement>("switch", { name: /RSVP/i });
    fireEvent.click(rsvp);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(rsvp.checked).toBe(true);
  });

  it("shows an error state with retry when loading fails", async () => {
    configureApiClient({ fetch: () => Promise.resolve(json({ error: "boom" }, 500)) });
    renderPage();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
