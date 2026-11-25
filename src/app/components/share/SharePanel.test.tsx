// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventDetail, EventViewer } from "../../api/events";
import { ToastProvider } from "../ui/Toast";
import { SharePanel } from "./SharePanel";

const EVENT: EventDetail = {
  id: "evt_1",
  slug: "k3f9xq2m",
  seriesId: null,
  kind: "admin_oneoff",
  title: "Thu Mixed Doubles",
  format: "XD",
  startsAt: "2027-03-11T18:00:00.000Z",
  endsAt: "2027-03-11T19:30:00.000Z",
  location: "Hall X",
  capacity: 16,
  adhocFee: 50,
  maxGuestsPerMember: 1,
  rsvpCloseAt: "2027-03-11T17:00:00.000Z",
  allocationMode: "tiered",
  status: "scheduled",
  readOnly: false,
};

const VIEWER: EventViewer = { canManage: false, canSeeAttendees: true };

describe("SharePanel (S7.1)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("uses the Web Share API when available", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });

    render(
      <ToastProvider>
        <SharePanel event={EVENT} viewer={VIEWER} />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /share/i }));
    await waitFor(() => {
      expect(share).toHaveBeenCalledTimes(1);
    });
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Thu Mixed Doubles",
        url: `${window.location.origin}/e/k3f9xq2m`,
      }),
    );
  });

  it("falls back to copying the prebuilt invite text when Web Share is unavailable", async () => {
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(
      <ToastProvider>
        <SharePanel event={EVENT} viewer={VIEWER} />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /share/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toContain("Thu Mixed Doubles");
    expect(copied).toContain("19:00");
    expect(copied).toContain("Hall X");
    expect(copied).toContain(`${window.location.origin}/e/k3f9xq2m`);
    expect(await screen.findByText(/copied/i)).toBeTruthy();
  });
});
