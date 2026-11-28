import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../api/client";
import type { EventDetail, EventViewer } from "../../api/events";
import { Slot } from "../../routes/events/slots";
import type { RsvpView } from "./api";
import { ToastProvider } from "../ui";
import { RsvpPanel } from "./RsvpPanel";
import "./register";

const render = (ui: ReactNode) => rtlRender(<ToastProvider>{ui}</ToastProvider>);

const event = (over: Partial<EventDetail> = {}): EventDetail => ({
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
  rsvpCloseAt: "2099-03-10T18:00:00.000Z",
  allocationMode: "tiered",
  status: "scheduled",
  readOnly: false,
  ...over,
});
const viewer: EventViewer = { canManage: false, canSeeAttendees: true };

const view = (over: Partial<RsvpView> = {}): RsvpView => ({
  id: "rsv_1",
  status: "requested",
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
  initial: RsvpView | null,
  respond?: (call: Call) => { status?: number; body: unknown },
) {
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
      const res =
        call.method === "GET"
          ? { body: { rsvp: initial } }
          : (respond?.(call) ?? { body: { rsvp: initial } });
      return Promise.resolve(new Response(JSON.stringify(res.body), { status: res.status ?? 200 }));
    },
  });
  return calls;
}

afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("RsvpPanel (S4.2)", () => {
  it("is registered in RsvpSlot", async () => {
    stub(null);
    render(<Slot name="RsvpSlot" event={event()} viewer={viewer} />);
    expect(await screen.findByRole("button", { name: "Going" })).toBeTruthy();
  });

  it("RSVPs with guests through the stepper and an Idempotency-Key, then shows Requested", async () => {
    const calls = stub(null, (call) => ({
      body: {
        rsvp: view({
          guests: (call.body as { guests: string[] }).guests.map((name, i) => ({
            id: `g${String(i)}`,
            name,
            status: "requested",
          })),
        }),
      },
    }));
    const onInstallState = vi.fn();
    window.addEventListener("bcq-install-state", onInstallState);
    try {
      render(<RsvpPanel event={event()} viewer={viewer} />);
      fireEvent.click(await screen.findByRole("button", { name: "Increase guests" }));
      fireEvent.change(screen.getByLabelText("Guest 1 name"), { target: { value: "Kim" } });
      fireEvent.click(screen.getByRole("button", { name: "Going" }));

      // The member and the guest each show a Requested chip.
      expect(await screen.findAllByText("Requested")).toHaveLength(2);
      const put = calls.find((c) => c.method === "PUT")!;
      expect(put.path).toBe("/events/evt_1/rsvp");
      expect(put.body).toEqual({ guests: ["Kim"] });
      expect(put.key).toBeTruthy();
      expect(onInstallState).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/when RSVPs close/i)).toBeTruthy();
    } finally {
      window.removeEventListener("bcq-install-state", onInstallState);
    }
  });

  it("the stepper stops at the event's guest limit and is hidden when guests are not allowed", async () => {
    stub(null);
    const { unmount } = render(
      <RsvpPanel event={event({ maxGuestsPerMember: 1 })} viewer={viewer} />,
    );
    const plus = await screen.findByRole("button", { name: "Increase guests" });
    fireEvent.click(plus);
    expect((plus as HTMLButtonElement).disabled).toBe(true);
    unmount();

    stub(null);
    render(<RsvpPanel event={event({ maxGuestsPerMember: 0 })} viewer={viewer} />);
    await screen.findByRole("button", { name: "Going" });
    expect(screen.queryByRole("group", { name: "guests" })).toBeNull();
  });

  it("shows Confirmed for an existing confirmed RSVP and cancels it", async () => {
    const calls = stub(view({ status: "confirmed", tier: 1 }), () => ({
      body: { rsvp: view({ status: "cancelled" }) },
    }));
    render(<RsvpPanel event={event()} viewer={viewer} />);
    expect(await screen.findByText("Confirmed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel RSVP" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Cancel" }));
    expect(await screen.findByRole("button", { name: "Going" })).toBeTruthy();
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.key).toBeTruthy();
  });

  it("shows the waitlist in instant mode, with guest statuses", async () => {
    stub(
      view({
        status: "waitlisted",
        guests: [{ id: "g1", name: "Kim", status: "waitlisted" }],
      }),
    );
    render(<RsvpPanel event={event({ allocationMode: "instant" })} viewer={viewer} />);
    expect(await screen.findAllByText("Waitlisted")).toHaveLength(2);
    const list = screen.getByRole("list", { name: "Your guests" });
    expect(within(list).getByText(/Kim/)).toBeTruthy();
  });

  it("after close (readOnly) it shows the status but no RSVP controls", async () => {
    stub(view({ status: "confirmed" }));
    render(<RsvpPanel event={event({ status: "closed", readOnly: true })} viewer={viewer} />);
    expect(await screen.findByText("Confirmed")).toBeTruthy();
    expect(screen.getByText(/RSVPs are closed/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel RSVP" })).toBeNull();
  });

  it("explains a server refusal in plain words", async () => {
    stub(null, () => ({ status: 409, body: { error: "rsvp_closed" } }));
    render(<RsvpPanel event={event()} viewer={viewer} />);
    fireEvent.click(await screen.findByRole("button", { name: "Going" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/closed/i);
    });
  });

  it("renders nothing for members who may not RSVP (403)", async () => {
    configureApiClient({
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })),
    });
    const { container } = render(<RsvpPanel event={event()} viewer={viewer} />);
    await waitFor(() => {
      expect(container.textContent).toBe("");
    });
  });

  it("marks Not Going via POST /rsvp/decline with an Idempotency-Key and stops reminders", async () => {
    const calls = stub(null, () => ({
      body: { rsvp: view({ status: "declined", guests: [] }) },
    }));
    render(<RsvpPanel event={event()} viewer={viewer} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not Going" }));

    expect(await screen.findByText("Not Going")).toBeTruthy();
    expect(screen.getByText(/won't get reminders for this event/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Not Going" })).toBeNull();
    expect(screen.getByRole("button", { name: "Going" })).toBeTruthy();
    const post = calls.find((c) => c.method === "POST" && c.path === "/events/evt_1/rsvp/decline");
    expect(post?.key).toBeTruthy();
  });

  it("applies ?quickRsvp=decline from a push action URL and cleans the query string", async () => {
    window.history.replaceState(null, "", "/events/k3f9xq2m?quickRsvp=decline");
    const calls = stub(null, () => ({
      body: { rsvp: view({ status: "declined", guests: [] }) },
    }));
    render(<RsvpPanel event={event()} viewer={viewer} />);

    expect(await screen.findByText("Not Going")).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(calls.some((c) => c.method === "POST" && c.path === "/events/evt_1/rsvp/decline")).toBe(
      true,
    );
  });

  it("hides Update RSVP when maxGuestsPerMember is 0 and opens Update RSVP Bottom Sheet when guests are allowed", async () => {
    stub(view({ status: "confirmed", guests: [] }));
    render(
      <ToastProvider>
        <RsvpPanel event={event({ maxGuestsPerMember: 0 })} viewer={viewer} />
      </ToastProvider>,
    );
    expect(await screen.findByRole("button", { name: "Cancel RSVP" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update RSVP" })).toBeNull();

    cleanup();
    const calls = stub(
      view({
        status: "confirmed",
        guests: [{ id: "g1", name: "Kim", status: "confirmed" }],
      }),
      () => ({
        body: {
          rsvp: view({
            status: "confirmed",
            guests: [
              { id: "g1", name: "Kim", status: "confirmed" },
              { id: "g2", name: "Alex", status: "confirmed" },
            ],
          }),
        },
      }),
    );
    render(
      <ToastProvider>
        <RsvpPanel event={event({ maxGuestsPerMember: 2, adhocFee: 100 })} viewer={viewer} />
      </ToastProvider>,
    );
    expect(await screen.findByText("You're in (1 guest).")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update RSVP" }));
    const sheet = await screen.findByRole("dialog", { name: "Update RSVP" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Increase guests" }));
    fireEvent.change(within(sheet).getByLabelText("Guest 2 name"), { target: { value: "Alex" } });
    expect(within(sheet).getByText("Guest fee: 2 × 100 kr = 200 kr")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByText("RSVP updated")).toBeTruthy();
    expect(screen.getByText("You're in (2 guests).")).toBeTruthy();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ guests: ["Kim", "Alex"] });
  });
});
