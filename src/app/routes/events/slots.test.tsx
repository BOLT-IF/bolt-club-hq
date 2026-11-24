import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { EventDetail, EventViewer } from "../../api/events";
import { clearSlots, registerSlot, Slot, SLOT_NAMES } from "./slots";

const event = { id: "evt_1", title: "Thu Mixed Doubles" } as EventDetail;
const viewer: EventViewer = { canManage: false, canSeeAttendees: true };

afterEach(() => {
  cleanup();
  clearSlots();
});

describe("event page slots", () => {
  it("offers exactly the four slots from PLAN §12", () => {
    expect([...SLOT_NAMES]).toEqual([
      "RsvpSlot",
      "ShareSlot",
      "OrganizerToolsSlot",
      "AttendeesSlot",
    ]);
  });

  it("renders nothing for a slot nobody filled", () => {
    const { container } = render(<Slot name="RsvpSlot" event={event} viewer={viewer} />);
    expect(container.innerHTML).toBe("");
  });

  it.each(SLOT_NAMES)("%s renders what is registered in it, with the event and viewer", (name) => {
    registerSlot(name, ({ event: e, viewer: v }) => (
      <p>
        {name}:{e.title}:{String(v.canManage)}
      </p>
    ));
    render(<Slot name={name} event={event} viewer={viewer} />);
    expect(screen.getByText(`${name}:Thu Mixed Doubles:false`)).toBeTruthy();
  });

  it("renders several registrations in order, and only in their own slot", () => {
    registerSlot("ShareSlot", () => <p>first</p>);
    registerSlot("ShareSlot", () => <p>second</p>);
    registerSlot("RsvpSlot", () => <p>elsewhere</p>);
    render(<Slot name="ShareSlot" event={event} viewer={viewer} />);
    expect(screen.getAllByText(/first|second/).map((n) => n.textContent)).toEqual([
      "first",
      "second",
    ]);
    expect(screen.queryByText("elsewhere")).toBeNull();
  });

  it("registerSlot returns an unregister function", () => {
    const off = registerSlot("ShareSlot", () => <p>gone soon</p>);
    off();
    const { container } = render(<Slot name="ShareSlot" event={event} viewer={viewer} />);
    expect(container.innerHTML).toBe("");
  });
});
