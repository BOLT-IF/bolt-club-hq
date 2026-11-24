import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { notification, outboundPush, pushSubscription } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { createNotifyPort } from "./notify";
import quietHours from "./policies/quiet-hours";
import { MAX_PUSH_ATTEMPTS, PUSH_BATCH_CAP, sendPushBatch } from "./push-sender";
import type { PushResult, PushTransport } from "./push-transport";

/** Mocked push service: answers per endpoint, records every send. */
function fakeTransport(answer: (endpoint: string) => PushResult = () => ({ kind: "ok" })) {
  const sent: { endpoint: string; payload: unknown }[] = [];
  const transport: PushTransport = {
    send(sub, payload) {
      sent.push({ endpoint: sub.endpoint, payload });
      return Promise.resolve(answer(sub.endpoint));
    },
  };
  return { transport, sent };
}

let seq = 0;

describe("push sender (cron batch)", () => {
  let t: TestDatabase;
  let clock: FixedClock;

  beforeEach(async () => {
    t = await createTestDatabase();
    // 12:00 Stockholm, outside quiet hours.
    clock = new FixedClock("2027-01-15T11:00:00Z");
  });

  afterEach(async () => {
    await t.close();
  });

  async function subscribe(memberId: string, n = 1) {
    const endpoints: string[] = [];
    for (let i = 0; i < n; i++) {
      const endpoint = `https://push.example.test/${String(++seq)}`;
      await t.db.insert(pushSubscription).values({
        id: `sub_${String(seq)}`,
        memberId,
        endpoint,
        keys: { p256dh: "p", auth: "a" },
      });
      endpoints.push(endpoint);
    }
    return endpoints;
  }

  async function queue(memberId: string, key = `k${String(++seq)}`) {
    await createNotifyPort({ db: t.db, clock, policies: [] }).notify({
      memberId,
      category: "rsvp_status",
      title: "You're in",
      body: "Monday 19:00",
      idempotencyKey: key,
      link: "/events/abc12345",
    });
    return `push_ntf_${key}`;
  }

  const row = async (id: string) =>
    (await t.db.select().from(outboundPush).where(eq(outboundPush.id, id)))[0];
  const subs = () => t.db.select().from(pushSubscription);

  it("success: sends the notification to every device and marks the row sent", async () => {
    const m = await makeMember(t.db);
    const endpoints = await subscribe(m.id, 2);
    const id = await queue(m.id);
    const { transport, sent } = fakeTransport();

    const result = await sendPushBatch({ db: t.db, clock, transport });

    expect(sent.map((s) => s.endpoint).sort()).toEqual([...endpoints].sort());
    expect(sent[0]?.payload).toMatchObject({
      title: "You're in",
      body: "Monday 19:00",
      url: "/events/abc12345",
      tag: "ntf_" + id.slice("push_ntf_".length),
    });
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 1 });
    for (const s of await subs()) {
      expect(s.lastSuccessAt?.toISOString()).toBe("2027-01-15T11:00:00.000Z");
      expect(s.failures).toBe(0);
    }
    expect(result).toMatchObject({ sends: 2, sent: 1 });
  });

  it("410 and 404 delete the subscription; with no device left the row fails", async () => {
    const m = await makeMember(t.db);
    const [gone, missing] = await subscribe(m.id, 2);
    const id = await queue(m.id);
    const { transport } = fakeTransport((e) =>
      e === gone ? { kind: "gone", status: 410 } : { kind: "gone", status: 404 },
    );

    await sendPushBatch({ db: t.db, clock, transport });

    expect(await subs()).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(missing).toBeDefined();
  });

  it("5xx backs off with a later not_before, then a retry succeeds", async () => {
    const m = await makeMember(t.db);
    await subscribe(m.id);
    const id = await queue(m.id);
    let status: PushResult = { kind: "retry", status: 503 };
    const { transport, sent } = fakeTransport(() => status);

    await sendPushBatch({ db: t.db, clock, transport });
    const first = await row(id);
    expect(first).toMatchObject({ status: "deferred", attempts: 1 });
    expect(first?.notBefore?.toISOString()).toBe("2027-01-15T11:10:00.000Z");
    expect((await subs())[0]?.failures).toBe(1);

    // Not due yet: nothing is sent.
    clock.advance(5 * 60_000);
    await sendPushBatch({ db: t.db, clock, transport });
    expect(sent).toHaveLength(1);

    clock.advance(5 * 60_000);
    status = { kind: "ok" };
    await sendPushBatch({ db: t.db, clock, transport });
    expect(sent).toHaveLength(2);
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 2 });
    expect((await subs())[0]?.failures).toBe(0);
  });

  it("backoff doubles and the row fails after the last attempt", async () => {
    const m = await makeMember(t.db);
    await subscribe(m.id);
    const id = await queue(m.id);
    const { transport } = fakeTransport(() => ({ kind: "retry", status: 500 }));

    const gaps: number[] = [];
    for (let i = 0; i < MAX_PUSH_ATTEMPTS; i++) {
      const before = clock.now().getTime();
      await sendPushBatch({ db: t.db, clock, transport });
      const r = await row(id);
      if (r?.status === "deferred" && r.notBefore) {
        gaps.push((r.notBefore.getTime() - before) / 60_000);
        clock.set(r.notBefore);
      }
    }
    expect(gaps).toEqual([10, 20, 40, 80]);
    expect(await row(id)).toMatchObject({ status: "failed", attempts: MAX_PUSH_ATTEMPTS });
  });

  it("a retry that would land in quiet hours waits until quiet hours end", async () => {
    clock.set("2027-01-15T20:55:00Z"); // 21:55 Stockholm
    const m = await makeMember(t.db);
    await subscribe(m.id);
    const id = await queue(m.id);
    const { transport } = fakeTransport(() => ({ kind: "retry", status: 502 }));
    await sendPushBatch({ db: t.db, clock, transport });
    expect((await row(id))?.notBefore?.toISOString()).toBe("2027-01-16T07:00:00.000Z");
  });

  it("a member without a device: the row fails (the inbox still has it)", async () => {
    const m = await makeMember(t.db);
    const id = await queue(m.id);
    const { transport, sent } = fakeTransport();
    await sendPushBatch({ db: t.db, clock, transport });
    expect(sent).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "failed" });
    expect(await t.db.select().from(notification)).toHaveLength(1);
  });

  it("a batch never exceeds the size cap; the rest goes out on the next run", async () => {
    expect(PUSH_BATCH_CAP).toBe(20);
    for (let i = 0; i < 25; i++) {
      const m = await makeMember(t.db);
      await subscribe(m.id);
      await queue(m.id);
    }
    const { transport, sent } = fakeTransport();

    await sendPushBatch({ db: t.db, clock, transport });
    expect(sent).toHaveLength(PUSH_BATCH_CAP);
    await sendPushBatch({ db: t.db, clock, transport });
    expect(sent).toHaveLength(25);
    const statuses = (await t.db.select().from(outboundPush)).map((r) => r.status);
    expect(statuses.every((s) => s === "sent")).toBe(true);
  });

  it("the cap counts sends (encryptions), not rows: multi-device members are not split", async () => {
    for (let i = 0; i < 8; i++) {
      const m = await makeMember(t.db);
      await subscribe(m.id, 3);
      await queue(m.id);
    }
    const { transport, sent } = fakeTransport();
    await sendPushBatch({ db: t.db, clock, transport, batchCap: 10 });
    // 3 + 3 + 3 = 9; the fourth member's 3 devices would exceed 10, so they wait.
    expect(sent).toHaveLength(9);
    const sentRows = (await t.db.select().from(outboundPush)).filter((r) => r.status === "sent");
    expect(sentRows).toHaveLength(3);
  });

  it("a message held by quiet hours is delivered at 08:00 Stockholm", async () => {
    clock.set("2027-01-15T22:00:00Z"); // 23:00 Stockholm (winter, UTC+1)
    const m = await makeMember(t.db);
    await subscribe(m.id);
    await createNotifyPort({ db: t.db, clock, policies: [quietHours] }).notify({
      memberId: m.id,
      category: "rsvp_status",
      title: "Late news",
      body: "b",
      idempotencyKey: "late",
    });
    const id = "push_ntf_late";
    expect(await row(id)).toMatchObject({ status: "deferred" });
    const { transport, sent } = fakeTransport();

    clock.set("2027-01-16T06:50:00Z"); // 07:50 Stockholm
    await sendPushBatch({ db: t.db, clock, transport });
    expect(sent).toHaveLength(0);

    clock.set("2027-01-16T07:00:00Z"); // 08:00 Stockholm
    await sendPushBatch({ db: t.db, clock, transport });
    expect(sent).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "sent" });
  });

  it("sent and failed rows are never sent again", async () => {
    const m = await makeMember(t.db);
    await subscribe(m.id);
    await queue(m.id);
    const { transport, sent } = fakeTransport();
    await sendPushBatch({ db: t.db, clock, transport });
    await sendPushBatch({ db: t.db, clock, transport });
    expect(sent).toHaveLength(1);
  });
});
