import { describe, expect, it } from "vitest";

import type { CurrentMember } from "../core/ports";
import {
  canManageEvent,
  canSeeAttendees,
  eventOgKey,
  isOpenForNext,
  isReadOnly,
  ogSnapshot,
} from "./rules";

const NOW = new Date("2027-03-10T12:00:00Z");
const HOUR = 3_600_000;

const event = {
  kind: "series" as const,
  seriesId: "ser_1" as string | null,
  createdBy: "admin_1",
  status: "scheduled" as "scheduled" | "closed" | "cancelled" | "completed",
  startsAt: new Date(NOW.getTime() + 24 * HOUR),
  endsAt: new Date(NOW.getTime() + 25 * HOUR),
  rsvpCloseAt: new Date(NOW.getTime() + 2 * HOUR),
};

const member = (over: Partial<CurrentMember> = {}): CurrentMember => ({
  id: "mem_1",
  role: "member",
  status: "active",
  seriesIds: [],
  ...over,
});

describe("isReadOnly: past events cannot be edited", () => {
  it("is false for a scheduled future event", () => {
    expect(isReadOnly(event, NOW)).toBe(false);
  });
  it("is true once the event has ended, and exactly at its end", () => {
    expect(isReadOnly({ ...event, endsAt: new Date(NOW.getTime() - 1) }, NOW)).toBe(true);
    expect(isReadOnly({ ...event, endsAt: NOW }, NOW)).toBe(true);
  });
  it("is true for completed and cancelled events", () => {
    expect(isReadOnly({ ...event, status: "completed" }, NOW)).toBe(true);
    expect(isReadOnly({ ...event, status: "cancelled" }, NOW)).toBe(true);
  });
  it("stays editable when RSVPs have closed but the event has not happened", () => {
    expect(isReadOnly({ ...event, status: "closed" }, NOW)).toBe(false);
  });
});

describe("isOpenForNext: what series/.../next may return", () => {
  it("accepts a scheduled event whose RSVP window is open", () => {
    expect(isOpenForNext(event, NOW)).toBe(true);
  });
  it("skips cancelled and closed events", () => {
    expect(isOpenForNext({ ...event, status: "cancelled" }, NOW)).toBe(false);
    expect(isOpenForNext({ ...event, status: "closed" }, NOW)).toBe(false);
    expect(isOpenForNext({ ...event, status: "completed" }, NOW)).toBe(false);
  });
  it("skips an event whose close time has passed even if the status is not flipped yet", () => {
    expect(isOpenForNext({ ...event, rsvpCloseAt: NOW }, NOW)).toBe(false);
  });
  it("skips events that already ended", () => {
    expect(isOpenForNext({ ...event, endsAt: new Date(NOW.getTime() - HOUR) }, NOW)).toBe(false);
  });
});

describe("canManageEvent (PLAN §4)", () => {
  it("lets an admin manage anything", () => {
    expect(canManageEvent(member({ role: "admin" }), event)).toBe(true);
  });
  it("lets the creator manage their own one-off only", () => {
    const oneOff = { ...event, kind: "member_oneoff" as const, seriesId: null, createdBy: "mem_1" };
    expect(canManageEvent(member(), oneOff)).toBe(true);
    expect(canManageEvent(member({ id: "mem_2" }), oneOff)).toBe(false);
  });
  it("does not make the creator of a series event its manager", () => {
    expect(canManageEvent(member({ id: "admin_1" }), event)).toBe(false);
  });
  it("lets a captain manage their own series only", () => {
    expect(canManageEvent(member({ seriesIds: ["ser_1"] }), event)).toBe(true);
    expect(canManageEvent(member({ seriesIds: ["ser_2"] }), event)).toBe(false);
  });
  it("never lets a signed-out or non-active viewer manage", () => {
    expect(canManageEvent(null, event)).toBe(false);
    expect(canManageEvent(member({ role: "admin", status: "pending" }), event)).toBe(false);
  });
});

describe("canSeeAttendees (A3)", () => {
  it("is true for active members only", () => {
    expect(canSeeAttendees(member())).toBe(true);
    expect(canSeeAttendees(member({ status: "pending" }))).toBe(false);
    expect(canSeeAttendees(member({ status: "inactive" }))).toBe(false);
    expect(canSeeAttendees(null)).toBe(false);
  });
});

describe("OG publishing contract", () => {
  it("keys the snapshot by slug", () => {
    expect(eventOgKey("k3f9xq2m")).toBe("og:event:k3f9xq2m");
  });
  it("snapshots public fields only: no creator, no attendee data", () => {
    const snapshot = JSON.parse(
      ogSnapshot({
        shareSlug: "k3f9xq2m",
        title: "Thu Mixed Doubles",
        format: "XD",
        location: "Hall X",
        startsAt: new Date("2027-03-11T18:00:00Z"),
        endsAt: new Date("2027-03-11T19:30:00Z"),
        status: "scheduled",
      }),
    ) as Record<string, unknown>;
    expect(snapshot).toEqual({
      slug: "k3f9xq2m",
      title: "Thu Mixed Doubles",
      format: "XD",
      location: "Hall X",
      startsAt: "2027-03-11T18:00:00.000Z",
      endsAt: "2027-03-11T19:30:00.000Z",
      status: "scheduled",
    });
  });
});
