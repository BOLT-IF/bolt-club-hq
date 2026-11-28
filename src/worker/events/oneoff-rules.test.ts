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
      format: "Open",
      location: null,
      capacity: 8,
      maxGuestsPerMember: 1,
      adhocFee: 0,
      allocationMode: "instant",
    });
    expect(r.value.rsvpCloseAt.toISOString()).toBe(at(24));
  });

  it("keeps RSVPs open until the start when created less than 24h ahead for member one-offs", () => {
    const r = planOneoff(member, body({ startsAt: at(3), endsAt: at(5) }), NOW);
    expect(r.ok && r.value.rsvpCloseAt.toISOString()).toBe(at(3));
    expect(r.ok && r.value.allocationMode).toBe("instant");
  });

  it("forces instant confirmation when an admin creates a club event less than 24h ahead", () => {
    const free = planOneoff(admin, body({ startsAt: at(3), endsAt: at(5) }), NOW);
    expect(free.ok && free.value).toMatchObject({
      kind: "admin_oneoff",
      allocationMode: "instant",
      status: "scheduled",
      closedProcessedAt: null,
    });

    const paid = planOneoff(admin, body({ startsAt: at(3), endsAt: at(5), adhocFee: 120 }), NOW);
    expect(paid.ok && paid.value).toMatchObject({
      kind: "admin_oneoff",
      allocationMode: "instant",
      adhocFee: 120,
      status: "closed",
    });
    expect(paid.ok && paid.value.closedProcessedAt?.toISOString()).toBe(NOW.toISOString());
    expect(paid.ok && paid.value.rsvpCloseAt.toISOString()).toBe(NOW.toISOString());
  });

  it("a member can set an informational cost (settled outside app) but not club/tiered modes", () => {
    const withCost = planOneoff(member, body({ adhocFee: 100 }), NOW);
    expect(withCost.ok && withCost.value).toMatchObject({
      kind: "member_oneoff",
      adhocFee: 100,
      allocationMode: "instant",
      status: "scheduled",
    });
    for (const over of [{ allocationMode: "tiered" }, { eventScope: "club" }]) {
      expect(planOneoff(member, body(over), NOW)).toMatchObject({
        ok: false,
        status: 403,
        error: "admin_only",
      });
    }
    expect(planOneoff(member, body({ adhocFee: 0, allocationMode: "instant" }), NOW).ok).toBe(true);
  });

  it("an admin one-off is tiered by default, supports paid instant mode, and can opt into member scope", () => {
    const r = planOneoff(admin, body({ adhocFee: 150 }), NOW);
    expect(r.ok && r.value).toMatchObject({
      kind: "admin_oneoff",
      adhocFee: 150,
      allocationMode: "tiered",
      status: "scheduled",
    });
    const free = planOneoff(admin, body({ allocationMode: "instant" }), NOW);
    expect(free.ok && free.value).toMatchObject({
      allocationMode: "instant",
      status: "scheduled",
    });
    const paidInstant = planOneoff(admin, body({ adhocFee: 150, allocationMode: "instant" }), NOW);
    expect(paidInstant.ok && paidInstant.value).toMatchObject({
      kind: "admin_oneoff",
      adhocFee: 150,
      allocationMode: "instant",
      status: "closed",
    });
    const memberScoped = planOneoff(admin, body({ eventScope: "member", adhocFee: 80 }), NOW);
    expect(memberScoped.ok && memberScoped.value).toMatchObject({
      kind: "member_oneoff",
      adhocFee: 80,
      allocationMode: "instant",
      status: "scheduled",
    });
  });

  it("validates audienceKind, audienceSeriesId and eligibleMemberIds", () => {
    expect(
      planOneoff(member, body({ audienceKind: "series", audienceSeriesId: "ser_1" }), NOW),
    ).toMatchObject({ ok: true, value: { audienceKind: "series", audienceSeriesId: "ser_1" } });
    expect(
      planOneoff(member, body({ audienceKind: "members", eligibleMemberIds: ["m1", "m1"] }), NOW),
    ).toMatchObject({ ok: true, value: { audienceKind: "members", eligibleMemberIds: ["m1"] } });
    expect(planOneoff(member, body({ audienceKind: "series" }), NOW)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      planOneoff(member, body({ audienceKind: "members", eligibleMemberIds: [] }), NOW),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it.each([
    ["empty title", { title: " " }],
    ["start in the past", { startsAt: at(-1), endsAt: at(1) }],
    ["end before start", { endsAt: at(47) }],
    ["zero capacity", { capacity: 0 }],
    ["fractional fee", { adhocFee: 12.5 }],
    ["negative fee", { adhocFee: -1 }],
    ["negative guests", { maxGuestsPerMember: -1 }],
    ["unknown format", { format: "invalid" }],
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
