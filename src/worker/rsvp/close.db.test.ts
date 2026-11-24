import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  domainEventOutbox,
  event,
  guest,
  ledgerEntry,
  notification,
  outboundPush,
  rsvp,
  series,
  term,
} from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createEvent } from "../events/model";
import { configureEventsDeps } from "../events/deps";
import eventsRoutes from "../events/routes";
import { requestIdMiddleware } from "../ops/logging";
import { tickHooks } from "../scheduler/registry";
import { NEXT_DUE_KEY } from "../scheduler/schedule";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { FakePrepaid, FakePublishOg } from "../test-support/fakes";
import type { AppEnv } from "../types";
import { closeDueEvents, closeEvent } from "./close";
import { CLOSE_TICK_HOOK, runCloseTick } from "./close-tick";
import { configureRsvpDeps } from "./deps";
import rsvpRoutes from "./routes";

const NOW = "2027-04-01T12:00:00Z";
const HOUR = 3_600_000;
const at = (hours: number): Date => new Date(new Date(NOW).getTime() + hours * HOUR);
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

function fakeKv() {
  const store = new Map<string, string>();
  const kv = {
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    put: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    },
    delete: (k: string) => {
      store.delete(k);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

describe("close processing + charges (S4.3)", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let prepaid: FakePrepaid;
  let keySeq = 0;

  const app = () =>
    new Hono<AppEnv>()
      .use("*", requestIdMiddleware({ now: () => clock.now().getTime() }))
      .route("/", eventsRoutes)
      .route("/", rsvpRoutes);

  const send = async (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    clerkUserId: string,
    opts: { body?: unknown; key?: string; env?: Cloudflare.Env } = {},
  ) => {
    const headers: Record<string, string> = { [TEST_IDENTITY_HEADER]: clerkUserId };
    if (method !== "GET") {
      headers["Idempotency-Key"] = opts.key ?? `k${String(++keySeq)}`;
    }
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return app().request(path, init, opts.env ?? testEnv);
  };

  const putRsvpHttp = (eventId: string, clerkUserId: string, guests: string[] = []) =>
    send("PUT", `/events/${eventId}/rsvp`, clerkUserId, { body: { guests } });

  async function seedSeries() {
    await t.db
      .insert(term)
      .values({ id: "t1", name: "Spring", startsOn: "2027-01-01", endsOn: "2027-06-30" });
    await t.db.insert(series).values({
      id: "ser_1",
      termId: "t1",
      name: "Thursday Mixed",
      format: "XD",
      weekday: 4,
      startTime: "19:00",
      durationMin: 90,
      capacity: 4,
      passPrice: 1200,
      adhocFee: 120,
      shareSlug: "ser-slug-1",
      passCap: 4,
    });
  }

  async function addEvent(over: Partial<Parameters<typeof createEvent>[1]> = {}) {
    const admin = await makeMember(t.db, { role: "admin" });
    return createEvent(
      { db: t.db, clock, publishOg: new FakePublishOg() },
      {
        seriesId: "ser_1",
        kind: "series",
        createdBy: admin.id,
        title: "Thursday Mixed",
        format: "XD",
        startsAt: at(48),
        endsAt: at(49.5),
        location: "Hall X",
        capacity: 4,
        adhocFee: 120,
        maxGuestsPerMember: 2,
        rsvpCloseAt: at(24),
        allocationMode: "tiered",
        ...over,
      },
    );
  }

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock(NOW);
    prepaid = new FakePrepaid();
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
    configureRsvpDeps({ prepaid: () => prepaid });
    configureEventsDeps({ publishOg: () => new FakePublishOg() });
    await seedSeries();
  });

  afterEach(async () => {
    configureRequestDeps({});
    configureRsvpDeps({});
    configureEventsDeps({});
    await t.close();
  });

  describe("tests first: core invariants", () => {
    it("running close twice gives an identical result", async () => {
      const e = await addEvent({ capacity: 3, adhocFee: 120 });
      const p1 = await makeMember(t.db);
      const m1 = await makeMember(t.db);
      const m2 = await makeMember(t.db);
      prepaid.markPrepaid(p1.id, e.id);

      await putRsvpHttp(e.id, p1.clerkUserId, ["Prepaid Guest"]);
      clock.advance(1_000);
      await putRsvpHttp(e.id, m1.clerkUserId);
      clock.advance(1_000);
      await putRsvpHttp(e.id, m2.clerkUserId);

      clock.set(at(24));
      expect(await closeEvent(t.db, clock, e.id)).toBe(true);

      const snapshot = async () => ({
        events: await t.db.select().from(event).where(eq(event.id, e.id)),
        rsvps: await t.db.select().from(rsvp).where(eq(rsvp.eventId, e.id)),
        guests: await t.db.select().from(guest),
        ledger: await t.db.select().from(ledgerEntry),
        notifications: await t.db.select().from(notification),
        pushes: await t.db.select().from(outboundPush),
        outbox: await t.db
          .select()
          .from(domainEventOutbox)
          .where(eq(domainEventOutbox.type, "event_closed")),
      });

      const first = await snapshot();
      expect(first.events[0]).toMatchObject({ status: "closed" });
      expect(first.events[0]?.closedProcessedAt?.toISOString()).toBe(at(24).toISOString());

      clock.advance(60_000);
      expect(await closeEvent(t.db, clock, e.id)).toBe(false);
      expect(await closeDueEvents(t.db, clock)).toBe(0);

      const second = await snapshot();
      expect(second).toEqual(first);
    });

    it("concurrent closes produce one set of charges (Postgres)", async () => {
      const e = await addEvent({ capacity: 3, adhocFee: 120 });
      const m1 = await makeMember(t.db);
      const m2 = await makeMember(t.db);
      await putRsvpHttp(e.id, m1.clerkUserId, ["Kim"]);
      clock.advance(1_000);
      await putRsvpHttp(e.id, m2.clerkUserId);

      clock.set(at(24));
      const results = await Promise.all(
        Array.from({ length: 6 }, () => closeEvent(t.db, clock, e.id)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);

      const entries = await t.db.select().from(ledgerEntry);
      expect(entries).toHaveLength(3); // m1 + m2 + Kim
      expect(entries.reduce((sum, row) => sum + row.amountSek, 0)).toBe(360);
      expect(
        await t.db
          .select()
          .from(domainEventOutbox)
          .where(eq(domainEventOutbox.type, "event_closed")),
      ).toHaveLength(1);
    });

    it("skips a row locked by another transaction without waiting (SKIP LOCKED)", async () => {
      const e = await addEvent({ capacity: 2, adhocFee: 100 });
      const m = await makeMember(t.db);
      await putRsvpHttp(e.id, m.clerkUserId);
      clock.set(at(24));

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const onLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });

      const holder = t.db.transaction(async (tx) => {
        await tx.select().from(event).where(eq(event.id, e.id)).for("update");
        locked();
        await gate;
      });

      await onLocked;
      // Returns immediately with false because the row is locked.
      expect(await closeEvent(t.db, clock, e.id)).toBe(false);
      expect(await t.db.select().from(ledgerEntry)).toHaveLength(0);

      release();
      await holder;

      // Now the lock is free, so close succeeds.
      expect(await closeEvent(t.db, clock, e.id)).toBe(true);
      expect(await t.db.select().from(ledgerEntry)).toHaveLength(1);
    });

    it("a member one-off produces no ledger entries", async () => {
      const creator = await makeMember(t.db);
      const created = await send("POST", "/events", creator.clerkUserId, {
        body: {
          title: "Free Member Hit",
          startsAt: at(48).toISOString(),
          endsAt: at(50).toISOString(),
          capacity: 2,
          rsvpCloseAt: at(24).toISOString(),
        },
      });
      expect(created.status).toBe(201);
      const { event: createdDto } = await created.json<{ event: { id: string } }>();

      const m1 = await makeMember(t.db);
      const m2 = await makeMember(t.db);
      await putRsvpHttp(createdDto.id, creator.clerkUserId);
      clock.advance(1_000);
      await putRsvpHttp(createdDto.id, m1.clerkUserId);
      clock.advance(1_000);
      await putRsvpHttp(createdDto.id, m2.clerkUserId);

      clock.set(at(24));
      expect(await closeEvent(t.db, clock, createdDto.id)).toBe(true);

      const [closedRow] = await t.db.select().from(event).where(eq(event.id, createdDto.id));
      expect(closedRow?.status).toBe("closed");
      expect(closedRow?.closedProcessedAt?.toISOString()).toBe(at(24).toISOString());
      expect(await t.db.select().from(ledgerEntry)).toHaveLength(0);

      const rsvps = await t.db.select().from(rsvp).where(eq(rsvp.eventId, createdDto.id));
      expect(rsvps.filter((r) => r.status === "confirmed")).toHaveLength(2);
      expect(rsvps.filter((r) => r.status === "waitlisted")).toHaveLength(1);
    });

    it("at an admin paid one-off, everyone confirmed is charged (no tier 1)", async () => {
      const e = await addEvent({
        kind: "admin_oneoff",
        seriesId: null,
        adhocFee: 150,
        capacity: 3,
        maxGuestsPerMember: 1,
        allocationMode: "tiered",
      });
      const passHolder = await makeMember(t.db);
      const regular = await makeMember(t.db);
      const waitlisted = await makeMember(t.db);
      // Even if a test or port flags passHolder as prepaid, admin one-offs have no tier 1.
      prepaid.markPrepaid(passHolder.id, e.id);

      await putRsvpHttp(e.id, passHolder.clerkUserId, ["Alex"]);
      clock.advance(1_000);
      await putRsvpHttp(e.id, regular.clerkUserId);
      clock.advance(1_000);
      await putRsvpHttp(e.id, waitlisted.clerkUserId);

      clock.set(at(24));
      expect(await closeEvent(t.db, clock, e.id)).toBe(true);

      const entries = await t.db.select().from(ledgerEntry);
      expect(entries).toHaveLength(3); // passHolder + regular + guest Alex (waitlisted is 0)
      const byMember = (id: string) => entries.filter((x) => x.memberId === id);
      expect(byMember(passHolder.id).map((x) => [x.reason, x.amountSek])).toEqual(
        expect.arrayContaining([
          ["adhoc", 150],
          ["guest", 150],
        ]),
      );
      expect(byMember(regular.id).map((x) => [x.reason, x.amountSek])).toEqual([["adhoc", 150]]);
      expect(byMember(waitlisted.id)).toHaveLength(0);
    });

    it("prepaid members are never charged for themselves, but still pay for confirmed guests", async () => {
      const e = await addEvent({ capacity: 4, adhocFee: 120, maxGuestsPerMember: 2 });
      const prepaidOnly = await makeMember(t.db);
      const prepaidWithGuest = await makeMember(t.db);
      const nonPrepaid = await makeMember(t.db);
      prepaid.markPrepaid(prepaidOnly.id, e.id);
      prepaid.markPrepaid(prepaidWithGuest.id, e.id);

      await putRsvpHttp(e.id, prepaidOnly.clerkUserId);
      clock.advance(1_000);
      await putRsvpHttp(e.id, prepaidWithGuest.clerkUserId, ["Sam"]);
      clock.advance(1_000);
      await putRsvpHttp(e.id, nonPrepaid.clerkUserId);

      clock.set(at(24));
      expect(await closeEvent(t.db, clock, e.id)).toBe(true);

      const entries = await t.db.select().from(ledgerEntry);
      const forMember = (id: string) => entries.filter((x) => x.memberId === id);
      expect(forMember(prepaidOnly.id)).toHaveLength(0);
      expect(forMember(prepaidWithGuest.id)).toHaveLength(1);
      expect(forMember(prepaidWithGuest.id)[0]).toMatchObject({
        reason: "guest",
        amountSek: 120,
        eventId: e.id,
      });
      expect(forMember(prepaidWithGuest.id)[0]?.guestId).toBeTruthy();
      expect(forMember(nonPrepaid.id)).toHaveLength(1);
      expect(forMember(nonPrepaid.id)[0]).toMatchObject({
        reason: "adhoc",
        amountSek: 120,
        eventId: e.id,
        idempotencyKey: `close:${e.id}:${nonPrepaid.id}`,
      });
    });

    it("each notification is sent once", async () => {
      const e = await addEvent({ capacity: 3, adhocFee: 120, maxGuestsPerMember: 1 });
      const p = await makeMember(t.db);
      const m1 = await makeMember(t.db);
      const m2 = await makeMember(t.db);
      const m3 = await makeMember(t.db);
      prepaid.markPrepaid(p.id, e.id);

      await putRsvpHttp(e.id, p.clerkUserId);
      clock.advance(1_000);
      await putRsvpHttp(e.id, m1.clerkUserId, ["Guest1"]);
      clock.advance(1_000);
      await putRsvpHttp(e.id, m2.clerkUserId);
      clock.advance(1_000);
      await putRsvpHttp(e.id, m3.clerkUserId);

      clock.set(at(24));
      await closeEvent(t.db, clock, e.id);
      await closeEvent(t.db, clock, e.id);

      const rows = await t.db.select().from(notification);
      // m1 (confirmed, guest waitlisted), m2 (confirmed), m3 (waitlisted).
      // p was already confirmed before close and had no guests.
      expect(rows.map((r) => r.memberId).sort()).toEqual([m1.id, m2.id, m3.id].sort());
      expect(rows.every((r) => r.category === "rsvp_status")).toBe(true);
      expect(rows.every((r) => r.link === `/events/${e.shareSlug}`)).toBe(true);
      expect(rows.find((r) => r.memberId === m1.id)?.idempotencyKey).toBe(
        `close-notify:${e.id}:${m1.id}`,
      );
      expect(await t.db.select().from(outboundPush)).toHaveLength(3);
    });
  });

  describe("allocation, timestamps, outbox, and cancelled rows", () => {
    it("allocates tiered members before guests, sets confirmedAt from Clock, preserves tier-1 confirmedAt, and writes event_closed", async () => {
      const e = await addEvent({ capacity: 3, adhocFee: 100 });
      const p1 = await makeMember(t.db);
      const m1 = await makeMember(t.db);
      const m2 = await makeMember(t.db);
      const cancelled = await makeMember(t.db);
      prepaid.markPrepaid(p1.id, e.id);

      await putRsvpHttp(e.id, p1.clerkUserId, ["GuestA"]);
      const p1Before = clock.now();
      clock.advance(5_000);
      await putRsvpHttp(e.id, m1.clerkUserId);
      clock.advance(5_000);
      await putRsvpHttp(e.id, m2.clerkUserId);
      clock.advance(5_000);
      await putRsvpHttp(e.id, cancelled.clerkUserId, ["Ghost"]);
      await send("DELETE", `/events/${e.id}/rsvp`, cancelled.clerkUserId);

      clock.set(at(24));
      await closeEvent(t.db, clock, e.id);

      const rows = await t.db.select().from(rsvp).where(eq(rsvp.eventId, e.id));
      const byMember = new Map(rows.map((r) => [r.memberId, r]));
      expect(byMember.get(p1.id)?.status).toBe("confirmed");
      expect(byMember.get(p1.id)?.confirmedAt?.toISOString()).toBe(p1Before.toISOString());
      expect(byMember.get(m1.id)?.status).toBe("confirmed");
      expect(byMember.get(m1.id)?.confirmedAt?.toISOString()).toBe(at(24).toISOString());
      expect(byMember.get(m2.id)?.status).toBe("confirmed");
      expect(byMember.get(cancelled.id)?.status).toBe("cancelled");

      const guests = await t.db.select().from(guest);
      expect(guests.find((g) => g.name === "GuestA")?.status).toBe("waitlisted");
      expect(guests.find((g) => g.name === "Ghost")?.status).toBe("cancelled");

      // Prepaid p1 got notified because their guest changed requested -> waitlisted.
      const p1Notifs = await t.db
        .select()
        .from(notification)
        .where(eq(notification.memberId, p1.id));
      expect(p1Notifs).toHaveLength(1);

      const outbox = await t.db
        .select()
        .from(domainEventOutbox)
        .where(eq(domainEventOutbox.type, "event_closed"));
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.payload).toMatchObject({ eventId: e.id });
    });

    it("does not close open, cancelled, or already-closed events", async () => {
      const future = await addEvent({ rsvpCloseAt: at(10) });
      const cancelled = await addEvent({ status: "cancelled", rsvpCloseAt: at(-1) });
      expect(await closeEvent(t.db, clock, future.id)).toBe(false);
      expect(await closeEvent(t.db, clock, cancelled.id)).toBe(false);
      expect(await closeDueEvents(t.db, clock)).toBe(0);
    });
  });

  describe("close-on-read wiring", () => {
    it("caps close-on-read at 5 due events per read on GET /events", async () => {
      const viewer = await makeMember(t.db);
      for (let i = 0; i < 7; i++) {
        await addEvent({
          title: `Due ${String(i)}`,
          rsvpCloseAt: at(-10 + i),
          startsAt: at(10 + i),
          endsAt: at(12 + i),
        });
      }

      const first = await send("GET", "/events", viewer.clerkUserId);
      expect(first.status).toBe(200);
      const afterFirst = await t.db.select().from(event);
      expect(afterFirst.filter((e) => e.status === "closed")).toHaveLength(5);
      expect(afterFirst.filter((e) => e.status === "scheduled")).toHaveLength(2);

      const second = await send("GET", "/events", viewer.clerkUserId);
      expect(second.status).toBe(200);
      const afterSecond = await t.db.select().from(event);
      expect(afterSecond.filter((e) => e.status === "closed")).toHaveLength(7);
    });

    it("prioritizes the requested event on GET /events/:id, GET /events/by-slug/:slug, and GET /events/:id/rsvp", async () => {
      const viewer = await makeMember(t.db);
      const events: Awaited<ReturnType<typeof addEvent>>[] = [];
      for (let i = 0; i < 7; i++) {
        events.push(
          await addEvent({
            title: `Session ${String(i)}`,
            rsvpCloseAt: at(-10 + i),
            startsAt: at(10 + i),
            endsAt: at(12 + i),
          }),
        );
      }
      const seventh = events[6]!;
      const sixth = events[5]!;
      await t.db.insert(rsvp).values({
        id: "rsv_target",
        eventId: sixth.id,
        memberId: viewer.id,
        status: "requested",
        tier: 2,
        requestedAt: at(-20),
      });

      const byId = await send("GET", `/events/${seventh.id}`, viewer.clerkUserId);
      expect(byId.status).toBe(200);
      expect((await byId.json<{ event: { status: string } }>()).event.status).toBe("closed");

      const byRsvp = await send("GET", `/events/${sixth.id}/rsvp`, viewer.clerkUserId);
      expect(byRsvp.status).toBe(200);
      expect((await byRsvp.json<{ rsvp: { status: string } }>()).rsvp?.status).toBe("confirmed");
    });

    it("closes due events on GET /events/by-slug/:slug and GET /series/by-slug/:slug/next", async () => {
      const viewer = await makeMember(t.db);
      const due = await addEvent({ rsvpCloseAt: at(-1), startsAt: at(10), endsAt: at(12) });
      const open = await addEvent({ rsvpCloseAt: at(24), startsAt: at(48), endsAt: at(50) });

      const bySlug = await send("GET", `/events/by-slug/${due.shareSlug}`, viewer.clerkUserId);
      expect(bySlug.status).toBe(200);
      expect((await bySlug.json<{ event: { status: string } }>()).event.status).toBe("closed");

      const due2 = await addEvent({ rsvpCloseAt: at(-2), startsAt: at(20), endsAt: at(22) });
      const next = await send("GET", "/series/by-slug/ser-slug-1/next", viewer.clerkUserId);
      expect(next.status).toBe(200);
      expect((await next.json<{ event: { id: string } }>()).event.id).toBe(open.id);
      const [closedDue2] = await t.db.select().from(event).where(eq(event.id, due2.id));
      expect(closedDue2?.status).toBe("closed");
    });
  });

  describe("scheduler tick hook & markDue", () => {
    it("registers the close hook on rsvp/routes load, closes all due events, and schedules next due", async () => {
      expect(tickHooks().has(CLOSE_TICK_HOOK)).toBe(true);

      for (let i = 0; i < 6; i++) {
        await addEvent({
          title: `Due ${String(i)}`,
          rsvpCloseAt: at(-6 + i),
          startsAt: at(10 + i),
          endsAt: at(12 + i),
        });
      }
      const nextA = await addEvent({ rsvpCloseAt: at(20), startsAt: at(40), endsAt: at(42) });
      await addEvent({ rsvpCloseAt: at(30), startsAt: at(50), endsAt: at(52) });

      const { kv, store } = fakeKv();
      await runCloseTick({ db: t.db, clock, now: clock.now(), kv });

      const all = await t.db.select().from(event);
      expect(all.filter((e) => e.status === "closed")).toHaveLength(6);
      expect(all.filter((e) => e.status === "scheduled")).toHaveLength(2);
      expect(store.get(NEXT_DUE_KEY)).toBe(String(nextA.rsvpCloseAt.getTime()));
    });

    it("marks KV due on one-off event creation", async () => {
      const m = await makeMember(t.db);
      const { kv, store } = fakeKv();
      const closeAt = at(20);
      const res = await send("POST", "/events", m.clerkUserId, {
        body: {
          title: "Evening Hit",
          startsAt: at(40).toISOString(),
          endsAt: at(42).toISOString(),
          capacity: 6,
          rsvpCloseAt: closeAt.toISOString(),
        },
        env: { ENV: "test", KV: kv } as unknown as Cloudflare.Env,
      });
      expect(res.status).toBe(201);
      expect(store.get(NEXT_DUE_KEY)).toBe(String(closeAt.getTime()));
    });
  });
});
