import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isoWeekday, localParts, weeklyOccurrences, zonedTimeToUtc } from "./recurrence";

const pad = (n: number) => String(n).padStart(2, "0");

describe("zonedTimeToUtc (Europe/Stockholm)", () => {
  it("uses UTC+1 in winter and UTC+2 in summer", () => {
    expect(zonedTimeToUtc("2027-01-14", "19:00").toISOString()).toBe("2027-01-14T18:00:00.000Z");
    expect(zonedTimeToUtc("2027-06-17", "19:00").toISOString()).toBe("2027-06-17T17:00:00.000Z");
  });

  it("is exact on both DST shift days (2027-03-28, 2027-10-31)", () => {
    expect(zonedTimeToUtc("2027-03-28", "19:00").toISOString()).toBe("2027-03-28T17:00:00.000Z");
    expect(zonedTimeToUtc("2027-10-31", "19:00").toISOString()).toBe("2027-10-31T18:00:00.000Z");
  });

  it("moves a skipped spring time forward and takes the first of a repeated autumn time", () => {
    expect(zonedTimeToUtc("2027-03-28", "02:30").toISOString()).toBe("2027-03-28T01:30:00.000Z");
    expect(zonedTimeToUtc("2027-10-31", "02:30").toISOString()).toBe("2027-10-31T00:30:00.000Z");
  });
});

describe("weeklyOccurrences", () => {
  const rule = {
    startsOn: "2027-03-01",
    endsOn: "2027-04-30",
    weekday: 7,
    startTime: "19:00",
    durationMin: 90,
    rsvpCloseOffsetMin: 1440,
  };

  it("lists every chosen weekday in the term, inclusive of both ends", () => {
    const dates = weeklyOccurrences({ ...rule, startsOn: "2027-03-07", endsOn: "2027-03-21" }).map(
      (o) => o.date,
    );
    expect(dates).toEqual(["2027-03-07", "2027-03-14", "2027-03-21"]);
  });

  it("leaves skip-dates out", () => {
    const dates = weeklyOccurrences({ ...rule, skipDates: ["2027-03-28"] }).map((o) => o.date);
    expect(dates).not.toContain("2027-03-28");
    expect(dates).toContain("2027-04-04");
  });

  it("computes rsvpCloseAt as absolute minutes before start, across the spring shift", () => {
    const shift = weeklyOccurrences(rule).find((o) => o.date === "2027-03-28");
    expect(shift?.startsAt.toISOString()).toBe("2027-03-28T17:00:00.000Z");
    // 24 h before in absolute time: 18:00 local the day before (still winter time).
    expect(shift?.rsvpCloseAt.toISOString()).toBe("2027-03-27T17:00:00.000Z");
    expect(shift?.endsAt.toISOString()).toBe("2027-03-28T18:30:00.000Z");
  });

  it("property: every occurrence lands on the right weekday and local time across both DST shifts", () => {
    // Terms that straddle the spring (late March) or autumn (late October) shift, 2025-2030.
    const termArb = fc.record({
      year: fc.integer({ min: 2025, max: 2030 }),
      shift: fc.constantFrom(3, 10),
      weekday: fc.integer({ min: 1, max: 7 }),
      hour: fc.integer({ min: 6, max: 23 }),
      minute: fc.constantFrom(0, 15, 30, 45),
      durationMin: fc.integer({ min: 30, max: 240 }),
      rsvpCloseOffsetMin: fc.integer({ min: 0, max: 7 * 1440 }),
    });
    fc.assert(
      fc.property(termArb, (t) => {
        const startTime = `${pad(t.hour)}:${pad(t.minute)}`;
        const occurrences = weeklyOccurrences({
          startsOn: `${String(t.year)}-${pad(t.shift - 1)}-01`,
          endsOn: `${String(t.year)}-${pad(t.shift + 1)}-28`,
          weekday: t.weekday,
          startTime,
          durationMin: t.durationMin,
          rsvpCloseOffsetMin: t.rsvpCloseOffsetMin,
        });
        expect(occurrences.length).toBeGreaterThanOrEqual(12);
        for (const o of occurrences) {
          const local = localParts(o.startsAt);
          expect(local.weekday).toBe(t.weekday);
          expect(isoWeekday(o.date)).toBe(t.weekday);
          expect(local.date).toBe(o.date);
          expect(local.time).toBe(startTime);
          expect(o.startsAt.getTime() - o.rsvpCloseAt.getTime()).toBe(
            t.rsvpCloseOffsetMin * 60_000,
          );
          expect(o.endsAt.getTime() - o.startsAt.getTime()).toBe(t.durationMin * 60_000);
        }
      }),
      { numRuns: 300 },
    );
  });
});
