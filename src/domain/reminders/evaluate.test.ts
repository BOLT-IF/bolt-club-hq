import { describe, expect, it } from "vitest";

import {
  nextEventWakeUp,
  planEventUnrsvped,
  planPaymentDue,
  stockholmDate,
  type OpenEvent,
  type PaymentMember,
  type ReminderRule,
} from "./index";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const paymentRule: Extract<ReminderRule, { kind: "payment_due" }> = {
  id: "r_pay",
  kind: "payment_due",
  enabled: true,
  minIntervalDays: 90,
  template: "Hi {name}, you owe {balance}. Ref {paymentRef}.",
  params: { thresholdSek: 200 },
};

const eventRule: Extract<ReminderRule, { kind: "event_unrsvped" }> = {
  id: "r_ev",
  kind: "event_unrsvped",
  enabled: true,
  minIntervalDays: 1,
  template: "{name}: are you coming to {event} ({when})? RSVP by {closes}.",
  params: { atPublish: true, hoursBeforeClose: 24 },
};

/** Runs the payment rule once a day at 10:00 UTC and returns the club-local dates it fired. */
function simulateDaily(from: string, days: number, balanceOn: (date: string) => number): string[] {
  let lastSentAt: Date | null = null;
  const fired: string[] = [];
  for (let i = 0; i < days; i++) {
    const now = new Date(Date.parse(`${from}T10:00:00Z`) + i * DAY_MS);
    const date = stockholmDate(now);
    const member: PaymentMember = {
      id: "m1",
      displayName: "Ada",
      paymentRef: "BC-ADA",
      balanceSek: balanceOn(date),
      lastSentAt,
    };
    const sends = planPaymentDue(paymentRule, { now, members: [member] });
    if (sends.length > 0) {
      fired.push(date);
      lastSentAt = now;
    }
  }
  return fired;
}

describe("payment due rule", () => {
  it("a 500 kr balance from 2027-01-01 with a 90-day rule fires on 01-01 and 04-01 only", () => {
    expect(simulateDaily("2027-01-01", 120, () => 500)).toEqual(["2027-01-01", "2027-04-01"]);
  });

  it("paying below the threshold stops the reminders", () => {
    const fired = simulateDaily("2027-01-01", 200, (date) => (date < "2027-02-15" ? 500 : 150));
    expect(fired).toEqual(["2027-01-01"]);
  });

  it("a balance exactly at the threshold reminds; credit never does", () => {
    const now = new Date("2027-01-01T10:00:00Z");
    const m = (id: string, balanceSek: number): PaymentMember => ({
      id,
      displayName: id,
      paymentRef: `BC-${id}`,
      balanceSek,
      lastSentAt: null,
    });
    const sends = planPaymentDue(paymentRule, {
      now,
      members: [m("at", 200), m("below", 199), m("credit", -300)],
    });
    expect(sends.map((s) => s.memberId)).toEqual(["at"]);
  });

  it("renders the template and keys the send by rule, member and club-local day", () => {
    const [send] = planPaymentDue(paymentRule, {
      now: new Date("2027-03-31T23:30:00Z"), // 01:30 on 1 April in Stockholm (CEST)
      members: [
        { id: "m1", displayName: "Ada", paymentRef: "BC-ADA", balanceSek: 500, lastSentAt: null },
      ],
    });
    expect(send).toMatchObject({
      key: "reminder:r_pay:m1:2027-04-01",
      body: "Hi Ada, you owe 500 kr. Ref BC-ADA.",
      link: "/money",
    });
  });
});

describe("un-RSVPed event rule", () => {
  const close = new Date("2027-03-10T17:00:00Z");
  const event: OpenEvent = {
    id: "e1",
    title: "Thursday doubles",
    slug: "thu-doubles",
    startsAt: new Date("2027-03-11T18:00:00Z"),
    rsvpCloseAt: close,
  };
  const members = [
    { id: "m1", displayName: "Ada" },
    { id: "m2", displayName: "Bo" },
  ];
  const base = { events: [event], members, sentKeys: new Set<string>() };

  it("skips members who responded", () => {
    const sends = planEventUnrsvped(eventRule, {
      ...base,
      now: new Date(close.getTime() - 3 * DAY_MS),
      responded: new Set(["e1:m2"]),
    });
    expect(sends.map((s) => s.memberId)).toEqual(["m1"]);
    expect(sends[0]).toMatchObject({
      key: "reminder:r_ev:e1:m1:publish",
      link: "/events/thu-doubles",
      body: "Ada: are you coming to Thursday doubles (Thu 11 Mar, 19:00)? RSVP by Wed 10 Mar, 18:00.",
    });
  });

  it("sends the publish stage once, then the pre-close stage once, nothing after close", () => {
    const sent = new Set<string>();
    const fired: string[] = [];
    for (let t = close.getTime() - 3 * DAY_MS; t <= close.getTime() + HOUR_MS; t += HOUR_MS) {
      for (const s of planEventUnrsvped(eventRule, {
        ...base,
        members: [members[0]!],
        now: new Date(t),
        responded: new Set(),
        sentKeys: sent,
      })) {
        sent.add(s.key);
        fired.push(`${s.key}@${new Date(t).toISOString()}`);
      }
    }
    expect(fired).toEqual([
      "reminder:r_ev:e1:m1:publish@2027-03-07T17:00:00.000Z",
      "reminder:r_ev:e1:m1:close@2027-03-09T17:00:00.000Z",
    ]);
  });

  it("first seen inside the pre-close window sends only the pre-close stage", () => {
    const sends = planEventUnrsvped(eventRule, {
      ...base,
      now: new Date(close.getTime() - 2 * HOUR_MS),
      responded: new Set(),
    });
    expect(sends.map((s) => s.key)).toEqual([
      "reminder:r_ev:e1:m1:close",
      "reminder:r_ev:e1:m2:close",
    ]);
  });

  it("an event further out than the publish lookahead is not reminded yet", () => {
    const sends = planEventUnrsvped(eventRule, {
      ...base,
      now: new Date(event.startsAt.getTime() - 8 * DAY_MS),
      responded: new Set(),
    });
    expect(sends).toEqual([]);
  });

  it("wakes the scheduler when the event enters the lookahead, then at the pre-close window", () => {
    expect(nextEventWakeUp(eventRule, [event], new Date("2027-03-01T00:00:00Z"))).toEqual(
      new Date(event.startsAt.getTime() - 7 * DAY_MS),
    );
    expect(nextEventWakeUp(eventRule, [event], new Date("2027-03-05T00:00:00Z"))).toEqual(
      new Date(close.getTime() - 24 * HOUR_MS),
    );
    expect(nextEventWakeUp(eventRule, [event], close)).toBeNull();
  });
});
