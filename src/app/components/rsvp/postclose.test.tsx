import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { configureApiClient } from "../../api/client";
import type { EventDetail, EventViewer } from "../../api/events";
import { Slot } from "../../routes/events/slots";
import { ToastProvider } from "../ui";
import type { RsvpView } from "./api";
import { PostCloseRsvpPanel } from "./postclose";
import "./register";

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

const view = (over: Partial<RsvpView> = {}): RsvpView => ({
  id: "rsv_1",
  status: "confirmed",
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

function stub(
  initial: {
    rsvp: RsvpView | null;
    freeSpots: number;
    waitlistCount: number;
    isPastCutoff?: boolean;
  },
  respond?: (call: Call) => { status?: number; body: unknown },
) {
  const calls: Call[] = [];
  let current = initial;
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
          new Response(JSON.stringify({ isPastCutoff: false, ...current }), { status: 200 }),
        );
      }
      const res = respond?.(call) ?? { body: { rsvp: current.rsvp } };
      if ((res.status ?? 200) < 400) {
        const nextRsvp = (res.body as { rsvp: RsvpView | null }).rsvp;
        current = { ...current, rsvp: nextRsvp };
      }
      return Promise.resolve(new Response(JSON.stringify(res.body), { status: res.status ?? 200 }));
    },
  });
  return calls;
}

afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("PostCloseRsvpPanel (S4.4a)", () => {
  it("is registered in RsvpSlot and renders when event is closed", async () => {
    stub({ rsvp: null, freeSpots: 2, waitlistCount: 0 });
    render(
      <ToastProvider>
        <Slot name="RsvpSlot" event={closedEvent()} viewer={viewer} />
      </ToastProvider>,
    );
    expect(await screen.findByRole("button", { name: "Join late" })).toBeTruthy();
  });

  it("renders nothing for an open scheduled event", () => {
    const calls = stub({ rsvp: null, freeSpots: 2, waitlistCount: 0 });
    const { container } = render(
      <PostCloseRsvpPanel
        event={closedEvent({ status: "scheduled", rsvpCloseAt: "2099-03-10T18:00:00.000Z" })}
        viewer={viewer}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("submits late RSVP with Idempotency-Key and shows Join waitlist when full", async () => {
    const calls = stub({ rsvp: null, freeSpots: 0, waitlistCount: 1 }, () => ({
      body: { rsvp: view({ status: "waitlisted" }) },
    }));
    render(<PostCloseRsvpPanel event={closedEvent()} viewer={viewer} />);
    fireEvent.click(await screen.findByRole("button", { name: "Join waitlist" }));

    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT");
      expect(put).toBeTruthy();
      expect(put?.path).toBe("/events/evt_1/rsvp/late");
      expect(put?.key).toBeTruthy();
    });
  });

  it("asks confirmation before late-cancelling a confirmed RSVP and sends POST late-cancel", async () => {
    const calls = stub(
      { rsvp: view({ status: "confirmed" }), freeSpots: 0, waitlistCount: 0 },
      () => ({
        body: { rsvp: view({ status: "late_cancelled" }) },
      }),
    );
    render(<PostCloseRsvpPanel event={closedEvent()} viewer={viewer} />);
    fireEvent.click(await screen.findByRole("button", { name: "Late cancel" }));

    expect(
      await screen.findByText(/120 kr charge stands unless your spot is refilled/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm late cancel" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST");
      expect(post?.path).toBe("/events/evt_1/rsvp/late-cancel");
      expect(post?.key).toBeTruthy();
    });
  });

  it("does not render duplicate RsvpPanel alongside PostCloseRsvpPanel for closed tiered or past-close scheduled events", async () => {
    const calls = stub({ rsvp: view({ status: "confirmed" }), freeSpots: 0, waitlistCount: 0 });
    const { container } = render(
      <ToastProvider>
        <Slot name="RsvpSlot" event={closedEvent({ allocationMode: "tiered" })} viewer={viewer} />
      </ToastProvider>,
    );
    expect(await screen.findByRole("button", { name: "Late cancel" })).toBeTruthy();
    expect(container.querySelectorAll(".bcq-rsvp")).toHaveLength(1);
    expect(calls.some((c) => c.path === "/events/evt_1/rsvp")).toBe(false);

    cleanup();
    const calls2 = stub({ rsvp: view({ status: "confirmed" }), freeSpots: 0, waitlistCount: 0 });
    const { container: c2 } = render(
      <ToastProvider>
        <Slot
          name="RsvpSlot"
          event={closedEvent({ status: "scheduled", rsvpCloseAt: "2020-03-10T18:00:00.000Z" })}
          viewer={viewer}
        />
      </ToastProvider>,
    );
    expect(await screen.findByRole("button", { name: "Late cancel" })).toBeTruthy();
    expect(c2.querySelectorAll(".bcq-rsvp")).toHaveLength(1);
    expect(calls2.some((c) => c.path === "/events/evt_1/rsvp")).toBe(false);
  });
});
