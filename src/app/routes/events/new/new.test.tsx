import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureApiClient } from "../../../api/client";
import { registeredFrontendRoutes, resolveRoute } from "../../registry";
import { NewEventPage } from "./NewEventPage";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function stubApi(responses: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  configureApiClient({
    fetch: (input, init) => {
      calls.push({ url: input, init });
      const hit = responses[`${init?.method ?? "GET"} ${input.replace("/api/v1", "")}`];
      return Promise.resolve(
        new Response(JSON.stringify(hit?.body ?? { error: "not_found" }), {
          status: hit?.status ?? (hit ? 200 : 404),
        }),
      );
    },
  });
  return calls;
}

const me = (role: "member" | "admin") => ({
  "GET /events/oneoff/options": { body: { canSetFee: role === "admin" } },
});

function fill() {
  fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Friday hit" } });
  fireEvent.change(screen.getByLabelText(/date/i), { target: { value: "2027-03-12" } });
  fireEvent.change(screen.getByLabelText(/^start/i), { target: { value: "19:00" } });
  fireEvent.change(screen.getByLabelText(/^end/i), { target: { value: "20:30" } });
  fireEvent.change(screen.getByLabelText(/spots/i), { target: { value: "8" } });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/events/new");
});

afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("/events/new", () => {
  it("is registered, and wins over /events/:slug", () => {
    expect(registeredFrontendRoutes().map((r) => r.path)).toContain("/events/new");
    expect(resolveRoute("/events/new")?.route.path).toBe("/events/new");
  });

  it("a member sees no fee or allocation fields", async () => {
    stubApi(me("member"));
    render(<NewEventPage />);
    expect(await screen.findByLabelText(/title/i)).toBeTruthy();
    expect(screen.queryByLabelText(/fee/i)).toBeNull();
    expect(screen.queryByLabelText(/tiered/i)).toBeNull();
    expect(screen.getByText(/free/i)).toBeTruthy();
  });

  it("an admin can set a fee and tiered allocation", async () => {
    stubApi(me("admin"));
    render(<NewEventPage />);
    expect(await screen.findByLabelText(/fee/i)).toBeTruthy();
    expect(screen.getByLabelText(/tiered/i)).toBeTruthy();
  });

  it("submits Stockholm wall time as UTC with an Idempotency-Key, then opens the event", async () => {
    const calls = stubApi({
      ...me("member"),
      "POST /events": { status: 201, body: { event: { id: "evt_1", slug: "abc123xyz0" } } },
    });
    render(<NewEventPage />);
    await screen.findByLabelText(/title/i);
    fill();
    fireEvent.click(screen.getByRole("button", { name: /create event/i }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/events/abc123xyz0");
    });
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(new Headers(post.init!.headers).get("Idempotency-Key")).toBeTruthy();
    expect(JSON.parse(post.init!.body as string)).toEqual({
      title: "Friday hit",
      location: null,
      format: "open",
      // 19:00 Stockholm in March (CET, UTC+1) is 18:00 UTC.
      startsAt: "2027-03-12T18:00:00.000Z",
      endsAt: "2027-03-12T19:30:00.000Z",
      capacity: 8,
      maxGuestsPerMember: 1,
    });
  });

  it("shows the server's validation error in an alert", async () => {
    stubApi({
      ...me("member"),
      "POST /events": {
        status: 400,
        body: { error: "invalid_body", message: "Ends before it starts" },
      },
    });
    render(<NewEventPage />);
    await screen.findByLabelText(/title/i);
    fill();
    fireEvent.click(screen.getByRole("button", { name: /create event/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/ends before it starts/i);
  });

  it("has no axe violations", async () => {
    stubApi(me("admin"));
    const { container } = render(<NewEventPage />);
    await screen.findByLabelText(/fee/i);
    const result = await axe.run(container);
    expect(result.violations).toEqual([]);
  });
});
