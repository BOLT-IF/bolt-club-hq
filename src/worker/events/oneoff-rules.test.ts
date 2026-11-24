import { describe, expect, it } from "vitest";

import type { CurrentMember } from "../core/ports";
import { FakePrepaid } from "../test-support/fakes";
import { planOneoff, rsvpTier } from "./oneoff-rules";

const NOW = new Date("2027-03-10T12:00:00Z");
const HOUR = 3_600_000;
const at = (h: number) => new Date(NOW.getTime() + h * HOUR).toISOString();

const member: CurrentMember = { id: "m1", role: "member", status: "active", seriesIds: [] };
const admin: CurrentMember = { id: "a1", role: "admin", status: "active", seriesIds: [] };

const body = (over: Record<string, unknown> = {}) => ({
  title: "Friday hit",
  startsAt: at(48),
  endsAt: at(50),
  capacity: 8,
  ...over,
});

describe("planOneoff", () => {
  it("a member gets a free, instant member one-off with defaults", () => {
    const r = planOneoff(member, body(), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      kind: "member_oneoff",
      title: "Friday hit",
      format: "open",
      location: null,
      capacity: 8,
      maxGuestsPerMember: 1,
      adhocFee: 0,
      allocationMode: "instant",
    });
    expect(r.value.rsvpCloseAt.toISOString()).toBe(at(24));
  });

  it("keeps RSVPs open until the start when created less than 24h ahead", () => {
    const r = planOneoff(member, body({ startsAt: at(3), endsAt: at(5) }), NOW);
    expect(r.ok && r.value.rsvpCloseAt.toISOString()).toBe(at(3));
  });

  it("a member can't set a fee or tiered allocation", () => {
    for (const over of [{ adhocFee: 100 }, { allocationMode: "tiered" }]) {
      expect(planOneoff(member, body(over), NOW)).toMatchObject({
        ok: false,
        status: 403,
        error: "admin_only",
      });
    }
    // Explicitly asking for what members get anyway is fine.
    expect(planOneoff(member, body({ adhocFee: 0, allocationMode: "instant" }), NOW).ok).toBe(true);
  });

  it("an admin one-off is tiered by default and may charge a fee", () => {
    const r = planOneoff(admin, body({ adhocFee: 150 }), NOW);
    expect(r.ok && r.value).toMatchObject({
      kind: "admin_oneoff",
      adhocFee: 150,
      allocationMode: "tiered",
    });
    const free = planOneoff(admin, body({ allocationMode: "instant" }), NOW);
    expect(free.ok && free.value.allocationMode).toBe("instant");
  });

  it("a paid admin one-off can't be instant (instant never charges)", () => {
    expect(
      planOneoff(admin, body({ adhocFee: 150, allocationMode: "instant" }), NOW),
    ).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it.each([
    ["empty title", { title: " " }],
    ["start in the past", { startsAt: at(-1), endsAt: at(1) }],
    ["end before start", { endsAt: at(47) }],
    ["zero capacity", { capacity: 0 }],
    ["fractional fee", { adhocFee: 12.5 }],
    ["negative fee", { adhocFee: -1 }],
    ["negative guests", { maxGuestsPerMember: -1 }],
    ["unknown format", { format: "singles" }],
    ["unknown allocation", { allocationMode: "lottery" }],
    ["close after start", { rsvpCloseAt: at(49) }],
    ["close in the past", { rsvpCloseAt: at(-1) }],
    ["unknown field", { kind: "series" }],
  ])("rejects %s with 400", (_name, over) => {
    expect(planOneoff(admin, body(over), NOW)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("rsvpTier", () => {
  it("a pass holder is treated as tier 2 at an admin paid one-off", async () => {
    const prepaid = new FakePrepaid();
    prepaid.markPrepaid("m1", "evt_1");
    const isPassHolder = await prepaid.isPrepaid({ memberId: "m1", eventId: "evt_1" });
    expect(isPassHolder).toBe(true);
    expect(rsvpTier({ kind: "admin_oneoff" }, isPassHolder)).toBe(2);
    expect(rsvpTier({ kind: "member_oneoff" }, isPassHolder)).toBe(2);
  });

  it("a series pass holder stays tier 1", () => {
    expect(rsvpTier({ kind: "series" }, true)).toBe(1);
    expect(rsvpTier({ kind: "series" }, false)).toBe(2);
  });
});
