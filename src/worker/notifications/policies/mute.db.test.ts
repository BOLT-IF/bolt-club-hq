import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { member, notification, notificationPref, outboundPush } from "../../../../db/schema";
import { FixedClock } from "../../core/clock";
import { createTestDatabase, type TestDatabase } from "../../test-support/database";
import { makeMember } from "../../test-support/factories";
import { createNotifyPort } from "../notify";
import mute from "./mute";

const clock = new FixedClock("2027-01-01T10:00:00Z");

describe("mute policy (through notify)", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });
  afterEach(async () => {
    await t.close();
  });

  const send = (memberId: string, category: string, key: string) =>
    createNotifyPort({ db: t.db, clock, policies: [mute] }).notify({
      memberId,
      category,
      title: "t",
      body: "b",
      idempotencyKey: key,
    });
  const counts = async () => ({
    inbox: (await t.db.select().from(notification)).length,
    pushes: (await t.db.select().from(outboundPush)).length,
  });

  it("is on by default: no prefs means the push is queued", async () => {
    const m = await makeMember(t.db);
    await send(m.id, "rsvp_status", "k1");
    expect(await counts()).toEqual({ inbox: 1, pushes: 1 });
  });

  it("a muted category still writes to the inbox but sends no push", async () => {
    const m = await makeMember(t.db);
    await t.db
      .insert(notificationPref)
      .values({ memberId: m.id, category: "rsvp_status", muted: true });
    await send(m.id, "rsvp_status", "k1");
    expect(await counts()).toEqual({ inbox: 1, pushes: 0 });
  });

  it("muting one category leaves the others and other members alone", async () => {
    const a = await makeMember(t.db);
    const b = await makeMember(t.db);
    await t.db
      .insert(notificationPref)
      .values({ memberId: a.id, category: "rsvp_status", muted: true });
    await send(a.id, "payment_due", "k1");
    await send(b.id, "rsvp_status", "k2");
    expect(await counts()).toEqual({ inbox: 2, pushes: 2 });
  });

  it("an explicit muted=false row behaves like the default", async () => {
    const m = await makeMember(t.db);
    await t.db
      .insert(notificationPref)
      .values({ memberId: m.id, category: "rsvp_status", muted: false });
    await send(m.id, "rsvp_status", "k1");
    expect(await counts()).toEqual({ inbox: 1, pushes: 1 });
  });

  it("global mute overrides per-category settings", async () => {
    const m = await makeMember(t.db);
    await t.db.insert(notificationPref).values({ memberId: m.id, category: "payment_due", muted: false });
    await t.db.update(member).set({ globalMute: true }).where(eq(member.id, m.id));
    await send(m.id, "payment_due", "k1");
    await send(m.id, "rsvp_status", "k2");
    expect(await counts()).toEqual({ inbox: 2, pushes: 0 });
  });
});
