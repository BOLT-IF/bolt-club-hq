import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureApiClient } from "../../api/client";
import { FeatureFlagsProvider } from "../../lib/flags";
import { registeredFrontendRoutes } from "../registry";
import type { Poll } from "./api";
import { AdminPollsPage } from "./AdminPollsPage";
import { PollDetailPage } from "./PollDetailPage";
import { PollListPage } from "./PollListPage";

const poll = (over: Partial<Poll> = {}): Poll => ({
  id: "pol_1",
  question: "Kit colour?",
  multiChoice: false,
  anonymous: false,
  resultsVisibility: "always",
  closesAt: "2027-03-04T12:00:00.000Z",
  closed: false,
  createdAt: "2027-03-01T12:00:00.000Z",
  options: [
    { id: "o_red", label: "Red" },
    { id: "o_blue", label: "Blue" },
  ],
  myVote: [],
  resultsVisible: true,
  results: {
    totalVoters: 3,
    options: [
      { optionId: "o_red", votes: 1, voters: [{ memberId: "m1", displayName: "Alice Voter" }] },
      { optionId: "o_blue", votes: 2, voters: [] },
    ],
  },
  ...over,
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubApi(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  configureApiClient({
    fetch: (input, init) => {
      const method = init?.method ?? "GET";
      const path = input.replace("/api/v1", "");
      calls.push({
        url: path,
        method,
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      });
      const hit = routes[`${method} ${path}`];
      const status = hit?.status ?? (hit ? 200 : 404);
      return Promise.resolve(
        status === 204
          ? new Response(null, { status })
          : new Response(JSON.stringify(hit?.body ?? { error: "not_found" }), { status }),
      );
    },
  });
  return calls;
}

const withFlag = (ui: ReactNode, on = true) => (
  <FeatureFlagsProvider flags={{ polls: on }}>{ui}</FeatureFlagsProvider>
);

beforeEach(() => {
  window.history.replaceState({}, "", "/polls/pol_1");
});

afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("polls routes registration", () => {
  it("registers the member list, the detail pattern and the admin page", () => {
    const paths = registeredFrontendRoutes().map((r) => r.path);
    for (const p of ["/polls", "/polls/:id", "/admin/polls"]) expect(paths).toContain(p);
  });
});

describe("feature flag", () => {
  it("shows nothing of polls while the flag is off, and calls no API", () => {
    const calls = stubApi({});
    render(withFlag(<PollListPage />, false));
    expect(screen.getByText(/polls aren.t available yet/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

describe("PollListPage", () => {
  it("lists polls as links with an open or closed chip", async () => {
    stubApi({
      "GET /polls": {
        body: { polls: [poll(), poll({ id: "pol_2", question: "Venue?", closed: true })] },
      },
    });
    render(withFlag(<PollListPage />));
    const link = await screen.findByRole("link", { name: /Kit colour\?/ });
    expect(link.getAttribute("href")).toBe("/polls/pol_1");
    expect(screen.getByRole("link", { name: /Venue\?/ }).textContent).toMatch(/closed/i);
  });

  it("has an empty state", async () => {
    stubApi({ "GET /polls": { body: { polls: [] } } });
    render(withFlag(<PollListPage />));
    expect(await screen.findByText(/no polls yet/i)).toBeTruthy();
  });
});

describe("PollDetailPage", () => {
  it("single choice uses radios and sends one option", async () => {
    const calls = stubApi({
      "GET /polls/pol_1": { body: { poll: poll() } },
      "PUT /polls/pol_1/vote": { body: { poll: poll({ myVote: ["o_blue"] }) } },
    });
    render(withFlag(<PollDetailPage />));
    const blue = await screen.findByRole("radio", { name: "Blue" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(blue);
    fireEvent.click(screen.getByRole("button", { name: /vote/i }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ optionIds: ["o_blue"] });
    });
    expect(await screen.findByText(/your vote is saved/i)).toBeTruthy();
  });

  it("multi choice uses checkboxes and sends every ticked option", async () => {
    const calls = stubApi({
      "GET /polls/pol_1": { body: { poll: poll({ multiChoice: true }) } },
      "PUT /polls/pol_1/vote": { body: { poll: poll({ multiChoice: true }) } },
    });
    render(withFlag(<PollDetailPage />));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Red" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Blue" }));
    fireEvent.click(screen.getByRole("button", { name: /vote/i }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ optionIds: ["o_red", "o_blue"] });
    });
  });

  it("vote button stays disabled until something is chosen", async () => {
    stubApi({ "GET /polls/pol_1": { body: { poll: poll() } } });
    render(withFlag(<PollDetailPage />));
    await screen.findByRole("radio", { name: "Red" });
    expect((screen.getByRole("button", { name: /vote/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a closed poll shows results and no voting controls", async () => {
    stubApi({ "GET /polls/pol_1": { body: { poll: poll({ closed: true }) } } });
    render(withFlag(<PollDetailPage />));
    expect(await screen.findByText(/closed/i)).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: /vote/i })).toBeNull();
    expect(screen.getByText(/2 votes/)).toBeTruthy();
  });

  it("tells the member when results are hidden", async () => {
    stubApi({
      "GET /polls/pol_1": {
        body: { poll: poll({ resultsVisible: false, results: null, resultsVisibility: "after_close" }) },
      },
    });
    render(withFlag(<PollDetailPage />));
    expect(await screen.findByText(/results are shown when the poll closes/i)).toBeTruthy();
  });

  it("shows who voted on a named poll, and says so on an anonymous one", async () => {
    stubApi({ "GET /polls/pol_1": { body: { poll: poll() } } });
    render(withFlag(<PollDetailPage />));
    expect(await screen.findByText(/Alice Voter/)).toBeTruthy();
    cleanup();

    const anon = poll({
      anonymous: true,
      results: { totalVoters: 3, options: [{ optionId: "o_red", votes: 1 }, { optionId: "o_blue", votes: 2 }] },
    });
    stubApi({ "GET /polls/pol_1": { body: { poll: anon } } });
    render(withFlag(<PollDetailPage />));
    expect(await screen.findByText(/anonymous/i)).toBeTruthy();
    expect(screen.queryByText(/Alice Voter/)).toBeNull();
  });

  it("explains a vote rejected because the poll just closed", async () => {
    stubApi({
      "GET /polls/pol_1": { body: { poll: poll() } },
      "PUT /polls/pol_1/vote": { status: 409, body: { error: "poll_closed" } },
    });
    render(withFlag(<PollDetailPage />));
    fireEvent.click(await screen.findByRole("radio", { name: "Red" }));
    fireEvent.click(screen.getByRole("button", { name: /vote/i }));
    expect(await screen.findByText(/this poll has closed/i)).toBeTruthy();
  });

  it("shows not-found for an unknown poll", async () => {
    stubApi({});
    render(withFlag(<PollDetailPage />));
    expect(await screen.findByText(/couldn.t find that poll/i)).toBeTruthy();
  });
});

describe("AdminPollsPage", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/admin/polls");
  });

  it("creates a poll with its settings", async () => {
    const calls = stubApi({
      "GET /polls": { body: { polls: [] } },
      "POST /polls": { status: 201, body: { poll: poll() } },
    });
    render(withFlag(<AdminPollsPage />));
    fireEvent.change(await screen.findByLabelText(/question/i), { target: { value: "Kit colour?" } });
    fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "Red" } });
    fireEvent.change(screen.getByLabelText("Option 2"), { target: { value: "Blue" } });
    fireEvent.click(screen.getByRole("button", { name: /add option/i }));
    fireEvent.change(screen.getByLabelText("Option 3"), { target: { value: "Green" } });
    fireEvent.click(screen.getByLabelText(/allow several choices/i));
    fireEvent.click(screen.getByLabelText(/anonymous/i));
    fireEvent.change(screen.getByLabelText(/who sees results/i), { target: { value: "after_close" } });
    fireEvent.click(screen.getByRole("button", { name: /create poll/i }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        question: "Kit colour?",
        options: ["Red", "Blue", "Green"],
        multiChoice: true,
        anonymous: true,
        resultsVisibility: "after_close",
        closesAt: null,
      });
    });
  });

  it("closes a poll early after confirming", async () => {
    const calls = stubApi({
      "GET /polls": { body: { polls: [poll()] } },
      "PATCH /polls/pol_1": { body: { poll: poll({ closed: true }) } },
    });
    render(withFlag(<AdminPollsPage />));
    fireEvent.click(await screen.findByRole("button", { name: /close now/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^close poll$/i }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ close: true });
    });
  });

  it("shows an admins-only state on 403", async () => {
    stubApi({ "GET /polls": { body: { polls: [] } }, "POST /polls": { status: 403, body: {} } });
    render(withFlag(<AdminPollsPage />));
    fireEvent.change(await screen.findByLabelText(/question/i), { target: { value: "Q" } });
    fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "a" } });
    fireEvent.change(screen.getByLabelText("Option 2"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: /create poll/i }));
    expect(await screen.findByText(/only admins can create polls/i)).toBeTruthy();
  });
});
