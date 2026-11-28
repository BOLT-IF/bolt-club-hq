/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- scenario test inspects JSON response bodies field by field. */
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ledgerEntry, member as memberTable, notification } from "../../db/schema";
import { createApp } from "../../src/worker/app";
import { FixedClock } from "../../src/worker/core/clock";
import { configureRequestDeps } from "../../src/worker/core/context";
import { TEST_IDENTITY_HEADER } from "../../src/worker/core/test-identity";
import { configureEventsDeps } from "../../src/worker/events/deps";
import { runReminders } from "../../src/worker/reminders/service";
import { configureRsvpDeps } from "../../src/worker/rsvp/deps";
import { createTestDatabase, type TestDatabase } from "../../src/worker/test-support/database";
import { makeMember } from "../../src/worker/test-support/factories";
import { FakePublishOg } from "../../src/worker/test-support/fakes";

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    put: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    },
    delete: (k: string) => {
      store.delete(k);
      return Promise.resolve();
    },
  };
}

type Member = Awaited<ReturnType<typeof makeMember>>;

describe("S11.1 club-week full term scenario", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let kv: ReturnType<typeof fakeKv>;
  let env: Cloudflare.Env;
  let keySeq = 0;

  const app = () => createApp();

  async function api(
    as: Member,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    opts: { body?: unknown; key?: string | null } = {},
  ) {
    const headers: Record<string, string> = { [TEST_IDENTITY_HEADER]: as.clerkUserId };
    if (method !== "GET" && opts.key !== null) {
      headers["Idempotency-Key"] = opts.key ?? `s11_${String(++keySeq)}`;
    }
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    const res = await app().request(`/api/v1${path}`, init, env);
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed test helper
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body };
  }

  function advanceTo(iso: string) {
    clock.set(new Date(iso));
  }

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock("2027-03-01T10:00:00Z");
    kv = fakeKv();
    env = { ENV: "test", KV: kv } as unknown as Cloudflare.Env;
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
    configureEventsDeps({ publishOg: () => new FakePublishOg() });
    configureRsvpDeps({});
  });

  afterEach(async () => {
    configureRequestDeps({});
    configureEventsDeps({});
    configureRsvpDeps({});
    await t.close();
  });

  it("runs a full term end-to-end and asserts the final ledger line by line", async () => {
    // Seed cast: 1 admin + 5 active members with short roster names.
    const admin = await makeMember(t.db, { role: "admin", displayName: "Admin Alice" });
    const captain = await makeMember(t.db, { displayName: "Captain Bob" });
    const paula = await makeMember(t.db, { displayName: "Paula Pass" });
    const rex = await makeMember(t.db, { displayName: "Rex Revoke" });
    const dana = await makeMember(t.db, { displayName: "Dana Dropin" });
    const leo = await makeMember(t.db, { displayName: "Leo Late" });

    await t.db.update(memberTable).set({ rosterName: "Bob" }).where(eq(memberTable.id, captain.id));
    await t.db.update(memberTable).set({ rosterName: "Paula" }).where(eq(memberTable.id, paula.id));
    await t.db.update(memberTable).set({ rosterName: "Rex" }).where(eq(memberTable.id, rex.id));
    await t.db.update(memberTable).set({ rosterName: "Dana" }).where(eq(memberTable.id, dana.id));
    await t.db.update(memberTable).set({ rosterName: "Leo" }).where(eq(memberTable.id, leo.id));

    // =========================================================================
    // ACT 1: Settings, term setup, series, captain, passes, and event generation
    // =========================================================================
    const settingsRes = await api(admin, "PUT", "/admin/settings", {
      body: {
        clubName: "BOLT IF",
        bank: { accountHolder: "BOLT IF", bankgiro: "5402-9681", swish: "1234567890" },
        paymentInstructions: "Pay with your ref",
        quietHours: { start: "22:00", end: "08:00" },
        autoPromoteCutoffMin: 120,
        defaults: { capacity: 12, passPrice: 400, adhocFee: 120 },
        accountCodes: { pass: "3010", adhoc: "3020" },
        rosterAppUrl: "https://roster.bolt.test/import",
      },
    });
    expect(settingsRes.status).toBe(200);

    // 4 Thursdays in March 2027: Mar 4, Mar 11, Mar 18, Mar 25.
    const termRes = await api(admin, "POST", "/terms", {
      body: { name: "Spring 2027", startsOn: "2027-03-01", endsOn: "2027-03-26" },
    });
    expect(termRes.status).toBe(201);
    const termId = termRes.body.term.id as string;

    const seriesRes = await api(admin, "POST", "/series", {
      body: {
        termId,
        name: "Thursday Mixed",
        format: "Mixed Doubles",
        weekday: 4,
        startTime: "19:00",
        durationMin: 90,
        location: "Hall A",
        capacity: 3,
        passPrice: 400,
        adhocFee: 120,
        maxGuestsDefault: 1,
        rsvpCloseOffsetMin: 1440,
      },
    });
    expect(seriesRes.status).toBe(201);
    const seriesId = seriesRes.body.series.id as string;

    const capRes = await api(admin, "PUT", `/series/${seriesId}/captains`, {
      body: { memberIds: [captain.id] },
    });
    expect(capRes.status).toBe(200);

    const genRes = await api(admin, "POST", `/series/${seriesId}/generate-events`);
    expect(genRes.status).toBe(200);
    expect(genRes.body.created).toBe(4);
    const event1Id = genRes.body.events[0].id as string;

    const openTermRes = await api(admin, "PATCH", `/terms/${termId}`, {
      body: { status: "open_for_passes" },
    });
    expect(openTermRes.status).toBe(200);

    // Paula & Rex check offers and buy passes (400 kr each).
    const offersRes = await api(paula, "GET", "/passes/offers");
    expect(offersRes.status).toBe(200);
    expect(offersRes.body.offers).toHaveLength(1);
    expect(offersRes.body.offers[0].priceSek).toBe(400);

    const paulaPassRes = await api(paula, "POST", "/passes", { body: { seriesId } });
    expect(paulaPassRes.status).toBe(201);

    advanceTo("2027-03-01T10:01:00Z");
    const rexPassRes = await api(rex, "POST", "/passes", { body: { seriesId } });
    expect(rexPassRes.status).toBe(201);
    const rexPassId = rexPassRes.body.pass.id as string;

    const activeTermRes = await api(admin, "PATCH", `/terms/${termId}`, {
      body: { status: "active" },
    });
    expect(activeTermRes.status).toBe(200);

    // =========================================================================
    // ACT 2: Admin-paid one-off & member one-off
    // =========================================================================
    advanceTo("2027-03-02T10:00:00Z");

    const clinicRes = await api(admin, "POST", "/events", {
      body: {
        title: "Sunday Clinic",
        format: "Open",
        startsAt: "2027-03-07T14:00:00Z",
        endsAt: "2027-03-07T16:00:00Z",
        rsvpCloseAt: "2027-03-06T14:00:00Z",
        location: "Hall B",
        capacity: 2,
        adhocFee: 150,
        maxGuestsPerMember: 1,
        allocationMode: "tiered",
      },
    });
    expect(clinicRes.status).toBe(201);
    const clinicId = clinicRes.body.event.id as string;

    const casualRes = await api(dana, "POST", "/events", {
      body: {
        title: "Friday Casual",
        format: "Open",
        startsAt: "2027-03-05T18:00:00Z",
        endsAt: "2027-03-05T19:30:00Z",
        rsvpCloseAt: "2027-03-05T17:00:00Z",
        location: "Hall C",
        capacity: 4,
        maxGuestsPerMember: 1,
      },
    });
    expect(casualRes.status).toBe(201);
    const casualId = casualRes.body.event.id as string;

    const listRes = await api(paula, "GET", "/events");
    expect(listRes.status).toBe(200);
    expect(listRes.body.events.length).toBe(6);

    // =========================================================================
    // ACT 3: RSVPs, close processing, late cancel, and waitlist refill
    // =========================================================================
    advanceTo("2027-03-02T12:00:00Z");
    // Capacity on event1 is 3: Paula (pass -> T1), Dana (T2), Leo (T2), Captain (T2, last).
    expect(
      (await api(paula, "PUT", `/events/${event1Id}/rsvp`, { body: { guests: [] } })).status,
    ).toBe(200);
    expect(
      (await api(dana, "PUT", `/events/${event1Id}/rsvp`, { body: { guests: [] } })).status,
    ).toBe(200);

    advanceTo("2027-03-02T12:05:00Z");
    expect(
      (await api(leo, "PUT", `/events/${event1Id}/rsvp`, { body: { guests: [] } })).status,
    ).toBe(200);

    advanceTo("2027-03-02T12:10:00Z");
    expect(
      (await api(captain, "PUT", `/events/${event1Id}/rsvp`, { body: { guests: [] } })).status,
    ).toBe(200);

    // Event #1 closes on 2027-03-03T18:00:00Z (24h before 19:00 Stockholm = 18:00Z).
    advanceTo("2027-03-03T18:05:00Z");
    const closedEventRes = await api(paula, "GET", `/events/${event1Id}`);
    expect(closedEventRes.status).toBe(200);
    expect(closedEventRes.body.event.status).toBe("closed");

    // Leo late-cancels -> Captain auto-promoted from waitlist and Leo is refilled (-120 kr).
    advanceTo("2027-03-03T19:00:00Z");
    const lateCancelRes = await api(leo, "POST", `/events/${event1Id}/rsvp/late-cancel`);
    expect(lateCancelRes.status).toBe(200);
    expect(lateCancelRes.body.rsvp.status).toBe("late_cancelled");

    // Member one-off (Friday Casual, instant, 0 kr): Paula & Leo RSVP going -> 0 ledger rows.
    advanceTo("2027-03-04T12:00:00Z");
    expect(
      (await api(paula, "PUT", `/events/${casualId}/rsvp`, { body: { guests: [] } })).status,
    ).toBe(200);
    expect(
      (await api(leo, "PUT", `/events/${casualId}/rsvp`, { body: { guests: [] } })).status,
    ).toBe(200);

    // =========================================================================
    // ACT 5 (on Event #1, the day after): Attendance marking & roster deep link
    // =========================================================================
    advanceTo("2027-03-05T10:00:00Z");
    const rosterRes = await api(captain, "GET", `/events/${event1Id}/roster-link`);
    expect(rosterRes.status).toBe(200);
    expect(rosterRes.body.url).toMatch(/^https:\/\/roster\.bolt\.test\/import\/planner#import=/);
    expect(rosterRes.body.players).toHaveLength(3);
    expect((rosterRes.body.textList as string).split("\n")).toEqual([
      "Paula Pass",
      "Dana Dropin",
      "Captain Bob",
    ]);

    const attBeforeRes = await api(captain, "GET", `/events/${event1Id}/attendance`);
    expect(attBeforeRes.status).toBe(200);
    const attendees = attBeforeRes.body.attendees as Array<{
      kind: string;
      id: string;
      memberId?: string;
    }>;
    const byMember = new Map(
      attendees.filter((a) => a.kind === "member" && a.memberId).map((r) => [r.memberId!, r.id]),
    );

    const markRes = await api(captain, "PUT", `/events/${event1Id}/attendance`, {
      body: {
        rsvps: [
          { id: byMember.get(paula.id), attendance: "attended" },
          { id: byMember.get(dana.id), attendance: "no_show" },
          { id: byMember.get(captain.id), attendance: "attended" },
        ],
      },
    });
    expect(markRes.status).toBe(200);

    // =========================================================================
    // ACT 4: Admin one-off with guest, close, material change & 24h free cancel
    // =========================================================================
    expect(
      (
        await api(paula, "PUT", `/events/${clinicId}/rsvp`, {
          body: { guests: ["Guest Gina"] },
        })
      ).status,
    ).toBe(200);

    // Clinic closes on 2027-03-06T14:00:00Z -> Paula charged 150 (adhoc) + 150 (guest).
    advanceTo("2027-03-06T14:05:00Z");
    const clinicEventRes = await api(paula, "GET", `/events/${clinicId}`);
    expect(clinicEventRes.status).toBe(200);
    expect(clinicEventRes.body.event.status).toBe("closed");

    // Material change to location -> opens 24h free-cancel window.
    advanceTo("2027-03-06T15:00:00Z");
    const matRes = await api(admin, "PATCH", `/events/${clinicId}/details`, {
      body: { location: "Hall Z (moved)" },
    });
    expect(matRes.status).toBe(200);

    // Paula cancels inside 24h window -> status is "cancelled" and both 150 kr charges reverse.
    advanceTo("2027-03-06T16:00:00Z");
    const freeCancelRes = await api(paula, "POST", `/events/${clinicId}/rsvp/late-cancel`);
    expect(freeCancelRes.status).toBe(200);
    expect(freeCancelRes.body.rsvp.status).toBe("cancelled");

    // =========================================================================
    // ACT 1b & 6: Pass revocation (22 days unpaid), Claims, Payments, Reminders, Poll
    // =========================================================================
    advanceTo("2027-03-23T10:00:00Z");
    const revokeRes = await api(admin, "POST", `/admin/passes/${rexPassId}/revoke`);
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.pass.status).toBe("revoked");

    advanceTo("2027-03-23T11:00:00Z");
    // Paula submits payment claim for 400 kr (her pass) and admin confirms it.
    const claimRes = await api(paula, "POST", "/me/payment-claims", {
      body: { amountSek: 400, paidOn: "2027-03-23", note: "Swish pass" },
    });
    expect(claimRes.status).toBe(201);
    const claimId = claimRes.body.id as string;

    const confirmRes = await api(admin, "POST", `/admin/payment-claims/${claimId}/confirm`);
    expect(confirmRes.status).toBe(200);

    // Admin records Captain Bob's 120 kr payment directly.
    advanceTo("2027-03-23T11:05:00Z");
    const payBobRes = await api(admin, "POST", "/admin/payments", {
      body: { memberId: captain.id, amountSek: 120, note: "Swish drop-in" },
    });
    expect(payBobRes.status).toBe(201);

    // Reminders: create payment_due rule (threshold 100 kr) and run engine.
    // Only Dana owes >= 100 kr (120 kr from Event #1 no-show).
    const ruleRes = await api(admin, "POST", "/admin/reminder-rules", {
      body: {
        kind: "payment_due",
        params: { thresholdSek: 100 },
        minIntervalDays: 30,
        template: "Hi {name}, you owe {balance}",
      },
    });
    expect(ruleRes.status).toBe(201);
    const remResult = await runReminders({ db: t.db, clock });
    expect(remResult.sent).toBe(1);

    const danaNotifs = await t.db
      .select()
      .from(notification)
      .where(eq(notification.memberId, dana.id));
    expect(danaNotifs.some((n) => n.category === "payment_due" && n.body.includes("120"))).toBe(
      true,
    );

    // Poll: create and vote.
    const pollRes = await api(admin, "POST", "/polls", {
      body: {
        question: "New shuttle brand?",
        options: ["Yonex", "Victor"],
        closesAt: "2027-03-30T12:00:00Z",
      },
    });
    expect(pollRes.status).toBe(201);
    const pollId = pollRes.body.poll.id as string;
    const optYonex = pollRes.body.poll.options[0].id as string;
    const optVictor = pollRes.body.poll.options[1].id as string;

    expect(
      (await api(paula, "PUT", `/polls/${pollId}/vote`, { body: { optionIds: [optYonex] } }))
        .status,
    ).toBe(200);
    expect(
      (await api(dana, "PUT", `/polls/${pollId}/vote`, { body: { optionIds: [optVictor] } }))
        .status,
    ).toBe(200);

    const pollAfterRes = await api(admin, "GET", `/polls/${pollId}`);
    expect(pollAfterRes.status).toBe(200);
    expect(pollAfterRes.body.poll.results.totalVoters).toBe(2);

    // =========================================================================
    // FINAL ASSERTIONS: Ledger line by line & member balances
    // =========================================================================
    const entries = await t.db
      .select({
        id: ledgerEntry.id,
        memberId: ledgerEntry.memberId,
        kind: ledgerEntry.kind,
        amountSek: ledgerEntry.amountSek,
        reason: ledgerEntry.reason,
        eventId: ledgerEntry.eventId,
        reversesEntryId: ledgerEntry.reversesEntryId,
        createdAt: ledgerEntry.createdAt,
      })
      .from(ledgerEntry)
      .orderBy(
        asc(ledgerEntry.createdAt),
        asc(ledgerEntry.reason),
        asc(ledgerEntry.memberId),
        asc(ledgerEntry.id),
      );

    expect(entries).toHaveLength(15);

    const summary = entries.map((e) => ({
      memberId: e.memberId,
      kind: e.kind,
      amountSek: e.amountSek,
      reason: e.reason,
      eventId: e.eventId,
      hasReversalTarget: e.reversesEntryId !== null,
    }));

    expect(summary).toEqual([
      // 1-2. Paula pass + Spring club fee
      {
        memberId: paula.id,
        kind: "charge",
        amountSek: 400,
        reason: "pass",
        eventId: null,
        hasReversalTarget: false,
      },
      {
        memberId: paula.id,
        kind: "charge",
        amountSek: 85,
        reason: "club_fee",
        eventId: null,
        hasReversalTarget: false,
      },
      // 3-4. Rex pass + Spring club fee
      {
        memberId: rex.id,
        kind: "charge",
        amountSek: 400,
        reason: "pass",
        eventId: null,
        hasReversalTarget: false,
      },
      {
        memberId: rex.id,
        kind: "charge",
        amountSek: 85,
        reason: "club_fee",
        eventId: null,
        hasReversalTarget: false,
      },
      // 3-4. Event #1 close charges (Dana & Leo; Paula is prepaid)
      {
        memberId: dana.id,
        kind: "charge",
        amountSek: 120,
        reason: "adhoc",
        eventId: event1Id,
        hasReversalTarget: false,
      },
      {
        memberId: leo.id,
        kind: "charge",
        amountSek: 120,
        reason: "adhoc",
        eventId: event1Id,
        hasReversalTarget: false,
      },
      // 5. Captain Bob auto-promoted when Leo late-cancelled
      {
        memberId: captain.id,
        kind: "charge",
        amountSek: 120,
        reason: "adhoc",
        eventId: event1Id,
        hasReversalTarget: false,
      },
      // 6. Leo refilled by Captain Bob's promotion
      {
        memberId: leo.id,
        kind: "reversal",
        amountSek: -120,
        reason: "adhoc",
        eventId: event1Id,
        hasReversalTarget: true,
      },
      // 7-8. Sunday Clinic close charges (Paula + Guest Gina)
      {
        memberId: paula.id,
        kind: "charge",
        amountSek: 150,
        reason: "adhoc",
        eventId: clinicId,
        hasReversalTarget: false,
      },
      {
        memberId: paula.id,
        kind: "charge",
        amountSek: 150,
        reason: "guest",
        eventId: clinicId,
        hasReversalTarget: false,
      },
      // 9-10. Free cancel inside 24h material-change window (reverses Paula + Guest Gina)
      {
        memberId: paula.id,
        kind: "reversal",
        amountSek: -150,
        reason: "adhoc",
        eventId: clinicId,
        hasReversalTarget: true,
      },
      {
        memberId: paula.id,
        kind: "reversal",
        amountSek: -150,
        reason: "guest",
        eventId: clinicId,
        hasReversalTarget: true,
      },
      // 11. Rex pass revoked after 21+ days unpaid
      {
        memberId: rex.id,
        kind: "reversal",
        amountSek: -400,
        reason: "revocation",
        eventId: null,
        hasReversalTarget: true,
      },
      // 12. Paula payment claim confirmed
      {
        memberId: paula.id,
        kind: "payment",
        amountSek: -400,
        reason: "payment",
        eventId: null,
        hasReversalTarget: false,
      },
      // 13. Captain Bob direct payment
      {
        memberId: captain.id,
        kind: "payment",
        amountSek: -120,
        reason: "payment",
        eventId: null,
        hasReversalTarget: false,
      },
    ]);

    // Verify reversal pointers point to the exact original charge IDs.
    expect(entries[7]?.reversesEntryId).toBe(entries[5]?.id); // Leo refill -> Leo adhoc
    expect(entries[10]?.reversesEntryId).toBe(entries[8]?.id); // Paula free cancel -> Paula clinic
    expect(entries[11]?.reversesEntryId).toBe(entries[9]?.id); // Paula free cancel -> Guest Gina
    expect(entries[12]?.reversesEntryId).toBe(entries[2]?.id); // Rex revoke -> Rex pass

    // Verify final balances via admin balances endpoint.
    const balancesRes = await api(admin, "GET", "/admin/balances");
    expect(balancesRes.status).toBe(200);
    const balById = new Map(
      (balancesRes.body.members as Array<{ id: string; balanceSek: number }>).map((m) => [
        m.id,
        m.balanceSek,
      ]),
    );
    expect(balById.get(paula.id)).toBe(85);
    expect(balById.get(rex.id)).toBe(85);
    expect(balById.get(dana.id)).toBe(120);
    expect(balById.get(leo.id)).toBe(0);
    expect(balById.get(captain.id)).toBe(0);
  });
});
