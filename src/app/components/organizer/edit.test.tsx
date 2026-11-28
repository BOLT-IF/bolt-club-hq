import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../api/client";
import type { EventDetail, EventViewer } from "../../api/events";
import { EventEditPanel } from "./edit";

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
  status: "scheduled",
  readOnly: false,
};

const managerViewer: EventViewer = { canManage: true, canSeeAttendees: true };

afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("EventEditPanel (S4.4c)", () => {
  it("renders nothing for non-managers or cancelled events", () => {
    const { container: c1 } = render(
      <EventEditPanel event={baseEvent} viewer={{ canManage: false, canSeeAttendees: true }} />,
    );
    expect(c1.firstChild).toBeNull();

    const { container: c2 } = render(
      <EventEditPanel event={{ ...baseEvent, status: "cancelled" }} viewer={managerViewer} />,
    );
    expect(c2.firstChild).toBeNull();
  });

  it("locks the fee input when the event is closed", () => {
    render(<EventEditPanel event={{ ...baseEvent, status: "closed" }} viewer={managerViewer} />);
    const feeInput = screen.getByLabelText<HTMLInputElement>(/Drop-in fee/i);
    expect(feeInput.disabled).toBe(true);
    expect(screen.getByText(/Fee cannot change after close/i)).toBeTruthy();
  });

  it("submits details changes with an Idempotency-Key", async () => {
    let sentBody: Record<string, unknown> | null = null;
    let sentKey: string | null = null;
    configureApiClient({
      fetch: (input, init) => {
        if (input === "/api/v1/events/evt_1/details" && init?.method === "PATCH") {
          sentBody = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<
            string,
            unknown
          >;
          sentKey = new Headers(init.headers).get("Idempotency-Key");
          return Promise.resolve(
            new Response(JSON.stringify({ event: baseEvent }), { status: 200 }),
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      },
    });

    render(<EventEditPanel event={baseEvent} viewer={managerViewer} />);
    fireEvent.change(screen.getByLabelText(/Location/i), { target: { value: "Hall Y" } });
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Changes saved");
    });
    expect(sentKey).toBeTruthy();
    expect(sentBody).toMatchObject({ location: "Hall Y", adhocFee: 100 });
  });

  it("confirms and cancels an event", async () => {
    let cancelCalled = false;
    configureApiClient({
      fetch: (input, init) => {
        if (input === "/api/v1/events/evt_1/cancel" && init?.method === "POST") {
          cancelCalled = true;
          return Promise.resolve(
            new Response(JSON.stringify({ event: { ...baseEvent, status: "cancelled" } }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      },
    });

    render(<EventEditPanel event={baseEvent} viewer={managerViewer} />);
    fireEvent.click(screen.getByRole("button", { name: /Cancel event/i }));
    const confirmButtons = screen.getAllByRole("button", { name: /Cancel event/i });
    const confirmBtn = confirmButtons[confirmButtons.length - 1];
    if (!confirmBtn) throw new Error("Confirm button not found");
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(cancelCalled).toBe(true);
      expect(screen.getByText(/Event cancelled/i)).toBeTruthy();
    });
  });

  it("formats and saves start/end times in Europe/Stockholm regardless of local timezone", async () => {
    vi.stubEnv("TZ", "America/New_York");
    let sentBody: Record<string, unknown> | null = null;
    try {
      configureApiClient({
        fetch: (input, init) => {
          if (input === "/api/v1/events/evt_1/details" && init?.method === "PATCH") {
            sentBody = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<
              string,
              unknown
            >;
            return Promise.resolve(
              new Response(JSON.stringify({ event: baseEvent }), { status: 200 }),
            );
          }
          return Promise.resolve(new Response("not found", { status: 404 }));
        },
      });

      render(<EventEditPanel event={baseEvent} viewer={managerViewer} />);
      const startsInput = screen.getByLabelText<HTMLInputElement>(/Starts/i);
      const endsInput = screen.getByLabelText<HTMLInputElement>(/Ends/i);

      // 2027-04-01T18:00:00.000Z is 20:00 CEST (UTC+2) in Europe/Stockholm
      expect(startsInput.value).toBe("2027-04-01T20:00");
      expect(endsInput.value).toBe("2027-04-01T21:30");

      fireEvent.change(startsInput, { target: { value: "2027-04-01T20:30" } });
      fireEvent.change(endsInput, { target: { value: "2027-04-01T22:00" } });
      fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

      await waitFor(() => {
        expect(screen.getByRole("status").textContent).toContain("Changes saved");
      });
      expect(sentBody).toMatchObject({
        startsAt: "2027-04-01T18:30:00.000Z",
        endsAt: "2027-04-01T20:00:00.000Z",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
