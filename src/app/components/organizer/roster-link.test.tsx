import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { configureApiClient } from "../../api/client";
import type { EventDetail, EventViewer } from "../../api/events";
import { RosterLinkPanel } from "./roster-link";

const closedEvent: EventDetail = {
  id: "evt_1",
  slug: "thu-mix-1",
  seriesId: "ser_1",
  kind: "series",
  title: "Thursday Mixed #1",
  format: "XD",
  startsAt: "2027-04-01T18:00:00.000Z",
  endsAt: "2027-04-01T19:30:00.000Z",
  location: "Hall X",
  capacity: 12,
  adhocFee: 100,
  maxGuestsPerMember: 1,
  rsvpCloseAt: "2027-04-01T12:00:00.000Z",
  allocationMode: "tiered",
  status: "closed",
  readOnly: false,
};

const managerViewer: EventViewer = { canManage: true, canSeeAttendees: true };

afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("RosterLinkPanel (S8.3)", () => {
  it("hides the panel for regular members and non-closed events", () => {
    const { container: c1 } = render(
      <RosterLinkPanel event={closedEvent} viewer={{ canManage: false, canSeeAttendees: true }} />,
    );
    expect(c1.firstChild).toBeNull();

    const { container: c2 } = render(
      <RosterLinkPanel event={{ ...closedEvent, status: "scheduled" }} viewer={managerViewer} />,
    );
    expect(c2.firstChild).toBeNull();
  });

  it("hides Open in roster generator when rosterAppUrl is unset, keeping Copy list", async () => {
    configureApiClient({
      fetch: (input) => {
        if (input === "/api/v1/events/evt_1/roster-link") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                rosterAppUrl: null,
                url: null,
                textList: "Alice\nBob",
                players: [
                  { name: "Alice", short: "Alice", guest: false },
                  { name: "Bob", short: "Bob", guest: true },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      },
    });

    render(<RosterLinkPanel event={closedEvent} viewer={managerViewer} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Copy list/i })).toBeTruthy();
    });
    expect(screen.queryByRole("link", { name: /Open in roster generator/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Open in roster generator/i })).toBeNull();
  });

  it("shows Open in roster generator when rosterAppUrl is set", async () => {
    const deepLink = "https://roster.example.se/planner#import=abc123";
    configureApiClient({
      fetch: (input) => {
        if (input === "/api/v1/events/evt_1/roster-link") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                rosterAppUrl: "https://roster.example.se",
                url: deepLink,
                textList: "Alice",
                players: [{ name: "Alice", short: "Alice", guest: false }],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      },
    });

    render(<RosterLinkPanel event={closedEvent} viewer={managerViewer} />);

    const link = await screen.findByRole<HTMLAnchorElement>("link", {
      name: /Open in roster generator/i,
    });
    expect(link.getAttribute("href")).toBe(deepLink);
    expect(screen.getByRole("button", { name: /Copy list/i })).toBeTruthy();
  });
});
