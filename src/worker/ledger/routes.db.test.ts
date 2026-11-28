import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { event, guest, rsvp } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import routes from "./routes";
import { createLedgerService } from "./service";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

interface LedgerBody {
  balanceSek: number;
  owedSek: number;
  creditSek: number;
  items: Array<{
    id: string;
    kind: string;
    reason: string;
    amountSek: number;
    status: string;
    allocatedSek: number;
    outstandingSek: number;
    note: string;
    createdAt: string;
    eventId: string | null;
    eventTitle: string | null;
    eventStartsAt: string | null;
    guestId: string | null;
    guestName: string | null;
  }>;
}

describe("GET /me/ledger", () => {
  let t: TestDatabase;
  let clock: FixedClock;

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock("2027-01-10T10:00:00Z");
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  const get = (path: string, clerkUserId?: string) =>
    routes.request(
      path,
      clerkUserId === undefined ? {} : { headers: { [TEST_IDENTITY_HEADER]: clerkUserId } },
      testEnv,
    );

  it("answers 401 without an identity", async () => {
    expect((await get("/me/ledger")).status).toBe(401);
  });

  it("returns the member's own balance, FIFO items, event date and guest name", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const m = await makeMember(t.db);
    const ledger = createLedgerService({ db: t.db, clock });

    await t.db.insert(event).values({
      id: "ev1",
      kind: "admin_oneoff",
      createdBy: admin.id,
      title: "Thursday XD",
      format: "Mixed Doubles",
      startsAt: new Date("2027-01-14T18:00:00Z"),
      endsAt: new Date("2027-01-14T19:30:00Z"),
      capacity: 12,
      adhocFee: 120,
      rsvpCloseAt: new Date("2027-01-13T18:00:00Z"),
      allocationMode: "tiered",
      shareSlug: "slug-ev1-abcdefgh",
    });
    await t.db.insert(rsvp).values({
      id: "rs1",
      eventId: "ev1",
      memberId: m.id,
      status: "confirmed",
      tier: 2,
      requestedAt: new Date("2027-01-10T09:00:00Z"),
    });
    await t.db.insert(guest).values({
      id: "g1",
      rsvpId: "rs1",
      name: "Sam Guest",
      status: "confirmed",
      requestedAt: new Date("2027-01-10T09:00:00Z"),
    });

    await ledger.charge({
      memberId: m.id,
      amountSek: 120,
      reason: "adhoc",
      eventId: "ev1",
      idempotencyKey: "c1",
    });
    clock.advance(1000);
    await ledger.charge({
      memberId: m.id,
      amountSek: 120,
      reason: "guest",
      eventId: "ev1",
      guestId: "g1",
      idempotencyKey: "c2",
    });
    clock.advance(1000);
    await ledger.recordPayment({
      memberId: m.id,
      amountSek: 150,
      actor: { id: admin.id, role: "admin", status: "active", seriesIds: [] },
      idempotencyKey: "p1",
    });

    const res = await get("/me/ledger", m.clerkUserId);
    expect(res.status).toBe(200);
    const body = await res.json<LedgerBody>();
    expect(body).toMatchObject({ balanceSek: 90, owedSek: 90, creditSek: 0 });
    expect(body.items.map((i) => i.kind)).toEqual(["charge", "charge", "payment"]);

    const [first, second, payment] = body.items;
    expect(first).toMatchObject({
      status: "paid",
      allocatedSek: 120,
      outstandingSek: 0,
      eventTitle: "Thursday XD",
      eventStartsAt: "2027-01-14T18:00:00.000Z",
      guestName: null,
    });
    expect(second).toMatchObject({
      status: "partly_paid",
      allocatedSek: 30,
      outstandingSek: 90,
      guestId: "g1",
      guestName: "Sam Guest",
    });
    expect(payment).toMatchObject({ amountSek: -150, allocatedSek: 150, outstandingSek: 0 });
  });

  it("shows credit as credit", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const m = await makeMember(t.db);
    await createLedgerService({ db: t.db, clock }).recordPayment({
      memberId: m.id,
      amountSek: 100,
      actor: { id: admin.id, role: "admin", status: "active", seriesIds: [] },
      idempotencyKey: "p",
    });
    const body = await (await get("/me/ledger", m.clerkUserId)).json<LedgerBody>();
    expect(body).toMatchObject({ balanceSek: -100, owedSek: 0, creditSek: 100 });
  });

  it("only ever returns the caller's own entries", async () => {
    const a = await makeMember(t.db);
    const b = await makeMember(t.db);
    const ledger = createLedgerService({ db: t.db, clock });
    await ledger.charge({ memberId: a.id, amountSek: 10, reason: "adhoc", idempotencyKey: "a" });
    await ledger.charge({ memberId: b.id, amountSek: 999, reason: "adhoc", idempotencyKey: "b" });
    const body = await (await get("/me/ledger", a.clerkUserId)).json<LedgerBody>();
    expect(body.balanceSek).toBe(10);
    expect(body.items).toHaveLength(1);
  });

  it("another member's ledger is 403, even for an admin, and the own id is fine", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const a = await makeMember(t.db);
    const b = await makeMember(t.db);
    expect((await get(`/me/ledger?memberId=${b.id}`, a.clerkUserId)).status).toBe(403);
    expect((await get(`/me/ledger?memberId=${a.id}`, admin.clerkUserId)).status).toBe(403);
    expect((await get(`/me/ledger?memberId=${a.id}`, a.clerkUserId)).status).toBe(200);
  });

  it("pending and erased members get 403, an exited (inactive) member still reads their ledger", async () => {
    const pending = await makeMember(t.db, { status: "pending" });
    const erased = await makeMember(t.db, { status: "erased" });
    const inactive = await makeMember(t.db, { status: "inactive" });
    await createLedgerService({ db: t.db, clock }).charge({
      memberId: inactive.id,
      amountSek: 70,
      reason: "adhoc",
      idempotencyKey: "i",
    });
    expect((await get("/me/ledger", pending.clerkUserId)).status).toBe(403);
    expect((await get("/me/ledger", erased.clerkUserId)).status).toBe(403);
    const res = await get("/me/ledger", inactive.clerkUserId);
    expect(res.status).toBe(200);
    expect((await res.json<LedgerBody>()).balanceSek).toBe(70);
  });
});
