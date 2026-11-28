import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { configureApiClient } from "../../api/client";
import type { EventDetail, EventViewer } from "../../api/events";
import { Slot } from "../../routes/events/slots";
import type { RsvpView } from "./api";
import { ClaimSpotPanel } from "./claim";
import { CapacityPanel } from "./claim-capacity";

const closedEvent = (over: Partial<EventDetail> = {}): EventDetail => ({
  id: "evt_1",
  slug: "k3f9xq2m",
  seriesId: "ser_1",
  kind: "series",
  title: "Thu",
  format: "Mixed Doubles",
  startsAt: "2099-03-11T18:00:00.000Z",
  endsAt: "2099-03-11T19:30:00.000Z",
  location: "Hall X",
  capacity: 12,
  adhocFee: 120,
  maxGuestsPerMember: 2,
  rsvpCloseAt: "2020-03-10T18:00:00.000Z",
  allocationMode: "tiered",
  status: "closed",
  readOnly: false,
  ...over,
});

const viewer: EventViewer = { canManage: false, canSeeAttendees: true };
const managerViewer: EventViewer = { canManage: true, canSeeAttendees: true };

const view = (over: Partial<RsvpView> = {}): RsvpView => ({
  id: "rsv_1",
  status: "offered",
  tier: 2,
  guests: [],
  ...over,
});

interface Call {
  method: string;
  path: string;
  body: unknown;
  key: string | null;
}

afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("ClaimSpotPanel & CapacityPanel (S4.4b)", () => {
  it("claims an offered spot with Idempotency-Key", async () => {
    const calls: Call[] = [];
    configureApiClient({
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        const call: Call = {
          method: init?.method ?? "GET",
          path: input.replace("/api/v1", ""),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          key: headers.get("Idempotency-Key"),
        };
        calls.push(call);
        if (call.method === "GET") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                rsvp: view({ status: "offered" }),
                freeSpots: 1,
                waitlistCount: 1,
                isPastCutoff: true,
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ rsvp: view({ status: "confirmed" }) }), { status: 200 }),
        );
      },
    });

    render(<Slot name="RsvpSlot" event={closedEvent()} viewer={viewer} />);
    const btn = await screen.findByRole("button", { name: "Claim spot" });
    fireEvent.click(btn);

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST");
      expect(post?.path).toBe("/events/evt_1/claim");
      expect(post?.key).toBeTruthy();
      expect(screen.getByText(/spot claimed/i)).toBeTruthy();
    });
  });

  it("shows capacity_below_confirmed override dialog and retries with override: true", async () => {
    const calls: Call[] = [];
    configureApiClient({
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        const call: Call = {
          method: init?.method ?? "GET",
          path: input.replace("/api/v1", ""),
          body,
          key: headers.get("Idempotency-Key"),
        };
        calls.push(call);
        if ((body as { override?: boolean } | undefined)?.override) {
          return Promise.resolve(
            new Response(JSON.stringify({ capacity: 2, waitlistedCount: 1 }), { status: 200 }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: "capacity_below_confirmed", confirmedCount: 3, capacity: 2 }),
            { status: 409 },
          ),
        );
      },
    });

    render(<CapacityPanel event={closedEvent({ capacity: 4 })} viewer={managerViewer} />);
    const input = screen.getByLabelText(/new capacity/i);
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Update capacity" }));

    expect(await screen.findByText(/3 confirmed/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /override/i }));

    await waitFor(() => {
      expect(calls).toHaveLength(2);
      expect(calls[1]?.body).toEqual({ capacity: 2, override: true });
      expect(screen.getByText(/capacity updated to 2/i)).toBeTruthy();
    });
  });

  it("renders nothing in ClaimSpotPanel when not offered", () => {
    configureApiClient({
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              rsvp: view({ status: "waitlisted" }),
              freeSpots: 0,
              waitlistCount: 1,
              isPastCutoff: false,
            }),
            { status: 200 },
          ),
        ),
    });
    const { container } = render(<ClaimSpotPanel event={closedEvent()} viewer={viewer} />);
    expect(container.firstChild).toBeNull();
  });
});
