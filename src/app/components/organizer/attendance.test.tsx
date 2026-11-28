import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { configureApiClient } from "../../api/client";
import type { EventDetail, EventViewer } from "../../api/events";
import { AttendancePanel } from "./attendance";

const baseEvent: EventDetail = {
  id: "evt_1",
  slug: "thu-mix-1",
  seriesId: "ser_1",
  kind: "series",
  title: "Thursday Mixed #1",
  format: "Mixed Doubles",
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

describe("AttendancePanel (S8.1)", () => {
  it("defaults everyone confirmed to attended and lets the organizer flip no-shows and save", async () => {
    let savedBody: unknown = null;
    configureApiClient({
      fetch: (input, init) => {
        if (
          input === "/api/v1/events/evt_1/attendance" &&
          (!init?.method || init.method === "GET")
        ) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                eventId: "evt_1",
                lockedForOrganizer: false,
                canEdit: true,
                hasUnmarked: true,
                attendees: [
                  {
                    kind: "member",
                    id: "rsvp_1",
                    memberId: "mem_1",
                    name: "Alice",
                    tier: 1,
                    attendance: "unknown",
                    effectiveAttendance: "attended",
                  },
                  {
                    kind: "guest",
                    id: "gst_1",
                    rsvpId: "rsvp_1",
                    hostName: "Alice",
                    name: "Bob (guest)",
                    tier: 3,
                    attendance: "unknown",
                    effectiveAttendance: "attended",
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (input === "/api/v1/events/evt_1/attendance" && init?.method === "PUT") {
          savedBody = JSON.parse(typeof init.body === "string" ? init.body : "{}");
          return Promise.resolve(
            new Response(
              JSON.stringify({
                eventId: "evt_1",
                lockedForOrganizer: false,
                canEdit: true,
                hasUnmarked: false,
                attendees: [
                  {
                    kind: "member",
                    id: "rsvp_1",
                    memberId: "mem_1",
                    name: "Alice",
                    tier: 1,
                    attendance: "attended",
                    effectiveAttendance: "attended",
                  },
                  {
                    kind: "guest",
                    id: "gst_1",
                    rsvpId: "rsvp_1",
                    hostName: "Alice",
                    name: "Bob (guest)",
                    tier: 3,
                    attendance: "no_show",
                    effectiveAttendance: "no_show",
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
        );
      },
    });

    render(<AttendancePanel event={baseEvent} viewer={managerViewer} />);

    expect(await screen.findByText("Alice")).toBeTruthy();
    const bobButton = screen.getByRole("button", { name: /Bob \(guest\)/i });
    fireEvent.click(bobButton);

    const saveButton = screen.getByRole("button", { name: /Save attendance/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(savedBody).toEqual({
        rsvps: [{ id: "rsvp_1", attendance: "attended" }],
        guests: [{ id: "gst_1", attendance: "no_show" }],
      });
    });
  });

  it("disables editing when locked and canEdit is false", async () => {
    configureApiClient({
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              eventId: "evt_1",
              lockedForOrganizer: true,
              canEdit: false,
              hasUnmarked: false,
              attendees: [
                {
                  kind: "member",
                  id: "rsvp_1",
                  memberId: "mem_1",
                  name: "Alice",
                  tier: 1,
                  attendance: "attended",
                  effectiveAttendance: "attended",
                },
              ],
            }),
            { status: 200 },
          ),
        ),
    });

    render(<AttendancePanel event={baseEvent} viewer={managerViewer} />);

    expect(await screen.findByText(/Ask an admin if a correction is needed/i)).toBeTruthy();
    const saveButton = screen.queryByRole("button", { name: /Save attendance/i });
    expect(saveButton).toBeNull();
  });
});
