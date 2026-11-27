import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureApiClient } from "../../api/client";
import type { EventDetail } from "../../api/events";
import { FeatureFlagsProvider, type FeatureFlags } from "../../lib/flags";
import { registeredFrontendRoutes } from "../registry";
import { HomePage } from "./HomePage";

const ALL_FLAGS: FeatureFlags = {
  events: true,
  money: true,
  inbox: true,
  polls: true,
};

const sampleEvent = (over: Partial<EventDetail> = {}): EventDetail => ({
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
  adhocFee: 100,
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
      const path = input.replace("/api/v1", "");
      const hit = routes[path];
      return Promise.resolve(
        new Response(JSON.stringify(hit?.body ?? { error: "not_found" }), {
          status: hit?.status ?? (hit ? 200 : 404),
        }),
      );
    },
  });
  return calls;
}

function renderHome(flags: FeatureFlags = ALL_FLAGS) {
  return render(
    <FeatureFlagsProvider flags={flags}>
      <HomePage />
    </FeatureFlagsProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("home route registration", () => {
  it("registers the root / route", () => {
    const paths = registeredFrontendRoutes().map((r) => r.path);
    expect(paths).toContain("/");
  });
});

describe("HomePage", () => {
  it("renders dashboard for a new member", async () => {
    stubApi({
      "/me": { body: { id: "mem_new", role: "member", status: "active", seriesIds: [] } },
      "/events": { body: { events: [sampleEvent()] } },
      "/events/evt_1/rsvp": { body: { rsvp: null } },
      "/me/ledger": { body: { balanceSek: 0, owedSek: 0, creditSek: 0, items: [] } },
      "/me/payment-claims": { body: { claims: [] } },
      "/passes/offers": {
        body: {
          offers: [
            {
              seriesId: "ser_1",
              seriesName: "Thu Mixed Doubles",
              termId: "term_1",
              termName: "Autumn 2026",
              format: "XD",
              weekday: 4,
              startTime: "18:00",
              durationMin: 90,
              location: "Hall X",
              passPrice: 900,
              priceSek: 900,
              remainingEvents: 10,
              totalEvents: 10,
              passCap: 16,
              passesSold: 4,
              seatsRemaining: 12,
              alreadyOwned: false,
              termsNotice: "Non-refundable",
            },
          ],
          passes: [],
        },
      },
      "/polls": {
        body: {
          polls: [
            {
              id: "pol_1",
              question: "Court preference?",
              multiChoice: false,
              anonymous: true,
              resultsVisibility: "after_vote",
              closesAt: null,
              closed: false,
              createdAt: "2027-03-01T10:00:00.000Z",
              options: [
                { id: "opt_1", label: "Hall X" },
                { id: "opt_2", label: "Hall Y" },
              ],
              myVote: [],
              resultsVisible: false,
              results: null,
            },
          ],
        },
      },
    });

    renderHome();

    expect(await screen.findByText("No upcoming RSVPs")).toBeTruthy();
    const eventLink = screen.getByRole("link", { name: /Thu Mixed Doubles/ });
    expect(eventLink.getAttribute("href")).toBe("/events/k3f9xq2m");
    expect(screen.getByText(/0 kr/)).toBeTruthy();
    expect(screen.getByText("No active pass")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Pass Offers/i }).getAttribute("href")).toBe(
      "/money/passes",
    );
    const pollLink = screen.getByRole("link", { name: /Court preference\?/ });
    expect(pollLink.getAttribute("href")).toBe("/polls/pol_1");
    expect(screen.getByText("Needs Your Vote")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Admin Tasks" })).toBeNull();
  });

  it("renders dashboard for a prepaid member", async () => {
    stubApi({
      "/me": { body: { id: "mem_prepaid", role: "member", status: "active", seriesIds: [] } },
      "/events": { body: { events: [sampleEvent()] } },
      "/events/evt_1/rsvp": {
        body: { rsvp: { id: "rsvp_1", status: "confirmed", tier: 1, guests: [] } },
      },
      "/me/ledger": { body: { balanceSek: 0, owedSek: 0, creditSek: 0, items: [] } },
      "/me/payment-claims": { body: { claims: [] } },
      "/passes/offers": {
        body: {
          offers: [],
          passes: [
            {
              id: "pass_1",
              seriesId: "ser_1",
              seriesName: "Thu Mixed Doubles",
              termName: "Autumn 2026",
              priceCharged: 900,
              eventsCovered: 10,
              status: "active",
              purchasedAt: "2026-09-01T10:00:00.000Z",
              revokedAt: null,
            },
          ],
        },
      },
      "/polls": { body: { polls: [] } },
    });

    renderHome();

    const rsvpLink = await screen.findByRole("link", { name: /Thu Mixed Doubles.*Confirmed/ });
    expect(rsvpLink.getAttribute("href")).toBe("/events/k3f9xq2m");
    const passLink = screen.getByRole("link", { name: /Thu Mixed Doubles.*Active Pass/ });
    expect(passLink.getAttribute("href")).toBe("/money/passes");
    expect(screen.getByText(/Autumn 2026/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Unanswered Events" })).toBeNull();
  });

  it("renders dashboard for a member who owes money with a pending claim", async () => {
    stubApi({
      "/me": { body: { id: "mem_debt", role: "member", status: "active", seriesIds: [] } },
      "/events": { body: { events: [] } },
      "/me/ledger": { body: { balanceSek: 150, owedSek: 150, creditSek: 0, items: [] } },
      "/me/payment-claims": {
        body: {
          claims: [
            {
              id: "clm_1",
              amountSek: 150,
              paidOn: "2026-11-20",
              note: "Swish",
              status: "pending",
              rejectionReason: null,
              createdAt: "2026-11-20T12:00:00.000Z",
            },
          ],
        },
      },
      "/passes/offers": { body: { offers: [], passes: [] } },
      "/polls": { body: { polls: [] } },
    });

    renderHome();

    expect(await screen.findByText(/Owes 150 kr/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Balance & Pay/i }).getAttribute("href")).toBe(
      "/money",
    );
    expect(screen.getByText(/1 pending claim/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /1 pending claim/i }).getAttribute("href")).toBe(
      "/money/claims",
    );
  });

  it("renders dashboard for an admin with tasks", async () => {
    stubApi({
      "/me": { body: { id: "mem_admin", role: "admin", status: "active", seriesIds: [] } },
      "/events": { body: { events: [] } },
      "/me/ledger": { body: { balanceSek: 0, owedSek: 0, creditSek: 0, items: [] } },
      "/me/payment-claims": { body: { claims: [] } },
      "/passes/offers": { body: { offers: [], passes: [] } },
      "/polls": { body: { polls: [] } },
      "/admin/join-requests": {
        body: {
          requests: [
            { memberId: "m1", displayName: "Nina" },
            { memberId: "m2", displayName: "Olle" },
          ],
        },
      },
      "/admin/payment-claims": {
        body: {
          claims: [{ id: "clm_2", amountSek: 100, status: "pending", isOwn: false }],
        },
      },
    });

    renderHome();

    expect(await screen.findByRole("heading", { name: "Admin Tasks" })).toBeTruthy();
    const joinLink = screen.getByRole("link", { name: /2 pending join requests/i });
    expect(joinLink.getAttribute("href")).toBe("/admin/approvals");
    const claimLink = screen.getByRole("link", { name: /1 pending payment claim/i });
    expect(claimLink.getAttribute("href")).toBe("/admin/money/claims");
  });

  it("respects feature flags when gated areas are off", async () => {
    const calls = stubApi({
      "/me": { body: { id: "mem_admin", role: "admin", status: "active", seriesIds: [] } },
      "/admin/join-requests": { body: { requests: [] } },
    });

    renderHome({});

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Admin Tasks" })).toBeTruthy();
    });

    expect(calls).toEqual(["/api/v1/me", "/api/v1/admin/join-requests"]);
    expect(screen.queryByRole("heading", { name: "Next RSVPs" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Money & Passes" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Open Polls" })).toBeNull();
  });

  it("shows pending membership state and error retry state", async () => {
    stubApi({
      "/me": { body: { id: "mem_pending", role: "member", status: "pending", seriesIds: [] } },
    });

    renderHome();
    expect(await screen.findByText("Membership Pending")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Check Join Status/i }).getAttribute("href")).toBe(
      "/join",
    );

    cleanup();
    stubApi({
      "/me": { status: 500, body: { error: "server_error" } },
    });

    renderHome();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try Again" })).toBeTruthy();
  });

  it("lets members RSVP or mark Not going directly from Unanswered events", async () => {
    const calls: string[] = [];
    configureApiClient({
      fetch: (input, init) => {
        const method = init?.method ?? "GET";
        calls.push(`${method} ${input}`);
        const path = input.replace("/api/v1", "");
        if (path === "/me") {
          return Promise.resolve(
            new Response(
              JSON.stringify({ id: "mem_1", role: "member", status: "active", seriesIds: [] }),
              { status: 200 },
            ),
          );
        }
        if (path === "/events") {
          return Promise.resolve(
            new Response(JSON.stringify({ events: [sampleEvent()] }), { status: 200 }),
          );
        }
        if (path === "/events/evt_1/rsvp" && method === "GET") {
          return Promise.resolve(new Response(JSON.stringify({ rsvp: null }), { status: 200 }));
        }
        if (path === "/events/evt_1/rsvp/decline" && method === "POST") {
          return Promise.resolve(
            new Response(
              JSON.stringify({ rsvp: { id: "r1", status: "declined", tier: 2, guests: [] } }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      },
    });

    renderHome({ events: true, money: false, inbox: false, polls: false });
    fireEvent.click(await screen.findByRole("button", { name: "Not Going to Thu Mixed Doubles" }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Unanswered events" })).toBeNull();
    });
    expect(calls).toContain("POST /api/v1/events/evt_1/rsvp/decline");
  });
});
