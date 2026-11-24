import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { AudienceError, resolveAudience } from "./audience";
import { makeCaptain, makeEvent, makePass, makeRsvp, makeSeries } from "./test-fixtures";

describe("resolveAudience", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });
  afterEach(async () => {
    await t.close();
  });

  it("all: every active member, and nobody pending, inactive or erased", async () => {
    const a = await makeMember(t.db);
    const b = await makeMember(t.db, { role: "admin" });
    await makeMember(t.db, { status: "pending" });
    await makeMember(t.db, { status: "inactive" });
    await makeMember(t.db, { status: "erased" });
    expect(await resolveAudience(t.db, { kind: "all" })).toEqual([a.id, b.id].sort());
  });

  it("pass_holders: members with an active pass, once each; revoked passes do not count", async () => {
    const s1 = await makeSeries(t.db);
    const s2 = await makeSeries(t.db);
    const holder = await makeMember(t.db);
    const twoPasses = await makeMember(t.db);
    const revoked = await makeMember(t.db);
    await makeMember(t.db); // no pass
    await makePass(t.db, holder.id, s1);
    await makePass(t.db, twoPasses.id, s1);
    await makePass(t.db, twoPasses.id, s2);
    await makePass(t.db, revoked.id, s1, "revoked");
    expect(await resolveAudience(t.db, { kind: "pass_holders" })).toEqual(
      [holder.id, twoPasses.id].sort(),
    );
    expect(await resolveAudience(t.db, { kind: "pass_holders", seriesId: s2 })).toEqual([
      twoPasses.id,
    ]);
  });

  it("pass_holders: an inactive holder is left out", async () => {
    const s = await makeSeries(t.db);
    const gone = await makeMember(t.db, { status: "inactive" });
    await makePass(t.db, gone.id, s);
    expect(await resolveAudience(t.db, { kind: "pass_holders" })).toEqual([]);
  });

  it("event_rsvps: live RSVPs of that event only (not cancelled, not other events)", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const e = await makeEvent(t.db, admin.id);
    const other = await makeEvent(t.db, admin.id);
    const confirmed = await makeMember(t.db);
    const waitlisted = await makeMember(t.db);
    const offered = await makeMember(t.db);
    const requested = await makeMember(t.db);
    const cancelled = await makeMember(t.db);
    const late = await makeMember(t.db);
    const elsewhere = await makeMember(t.db);
    await makeRsvp(t.db, e.id, confirmed.id, "confirmed");
    await makeRsvp(t.db, e.id, waitlisted.id, "waitlisted");
    await makeRsvp(t.db, e.id, offered.id, "offered");
    await makeRsvp(t.db, e.id, requested.id, "requested");
    await makeRsvp(t.db, e.id, cancelled.id, "cancelled");
    await makeRsvp(t.db, e.id, late.id, "late_cancelled");
    await makeRsvp(t.db, other.id, elsewhere.id, "confirmed");
    expect(await resolveAudience(t.db, { kind: "event_rsvps", eventId: e.id })).toEqual(
      [confirmed.id, waitlisted.id, offered.id, requested.id].sort(),
    );
  });

  it("event_rsvps: the event can also be named by its share slug", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const e = await makeEvent(t.db, admin.id);
    const m = await makeMember(t.db);
    await makeRsvp(t.db, e.id, m.id, "confirmed");
    expect(await resolveAudience(t.db, { kind: "event_rsvps", eventId: e.shareSlug })).toEqual([
      m.id,
    ]);
  });

  it("event_rsvps: an unknown event is an error, not an empty audience", async () => {
    await expect(
      resolveAudience(t.db, { kind: "event_rsvps", eventId: "nope" }),
    ).rejects.toMatchObject({ code: "event_not_found" });
    await expect(
      resolveAudience(t.db, { kind: "event_rsvps", eventId: "nope" }),
    ).rejects.toBeInstanceOf(AudienceError);
  });

  it("captains: members who captain a series, once each, optionally for one series", async () => {
    const s1 = await makeSeries(t.db);
    const s2 = await makeSeries(t.db);
    const both = await makeMember(t.db);
    const one = await makeMember(t.db);
    await makeMember(t.db); // not a captain
    await makeCaptain(t.db, s1, both.id);
    await makeCaptain(t.db, s2, both.id);
    await makeCaptain(t.db, s2, one.id);
    expect(await resolveAudience(t.db, { kind: "captains" })).toEqual([both.id, one.id].sort());
    expect(await resolveAudience(t.db, { kind: "captains", seriesId: s1 })).toEqual([both.id]);
  });
});
