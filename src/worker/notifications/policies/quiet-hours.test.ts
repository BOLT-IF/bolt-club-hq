import { describe, expect, it } from "vitest";

import { DEFAULT_QUIET_HOURS, quietUntil } from "./quiet-hours";

const at = (iso: string) => new Date(iso);

describe("quietUntil (Stockholm wall clock)", () => {
  it("defaults to 22:00-08:00 (PLAN A9)", () => {
    expect(DEFAULT_QUIET_HOURS).toEqual({ start: "22:00", end: "08:00" });
  });

  it("is null outside quiet hours", () => {
    // 12:00 Stockholm in winter (UTC+1).
    expect(quietUntil(at("2027-01-15T11:00:00Z"), DEFAULT_QUIET_HOURS)).toBeNull();
    // 21:59 Stockholm.
    expect(quietUntil(at("2027-01-15T20:59:00Z"), DEFAULT_QUIET_HOURS)).toBeNull();
    // 08:00 Stockholm exactly: quiet hours are over.
    expect(quietUntil(at("2027-01-15T07:00:00Z"), DEFAULT_QUIET_HOURS)).toBeNull();
  });

  it("before midnight holds until 08:00 Stockholm the next morning (winter, UTC+1)", () => {
    expect(quietUntil(at("2027-01-15T21:00:00Z"), DEFAULT_QUIET_HOURS)?.toISOString()).toBe(
      "2027-01-16T07:00:00.000Z",
    );
  });

  it("after midnight holds until 08:00 Stockholm the same morning (summer, UTC+2)", () => {
    expect(quietUntil(at("2027-06-15T01:30:00Z"), DEFAULT_QUIET_HOURS)?.toISOString()).toBe(
      "2027-06-15T06:00:00.000Z",
    );
  });

  it("is DST-safe: the night clocks go forward still ends at 08:00 local", () => {
    // 2027-03-28 is the spring-forward night in Stockholm. 23:00 local on the 27th (UTC+1).
    expect(quietUntil(at("2027-03-27T22:00:00Z"), DEFAULT_QUIET_HOURS)?.toISOString()).toBe(
      "2027-03-28T06:00:00.000Z",
    );
  });

  it("supports a window that does not cross midnight", () => {
    const lunch = { start: "12:00", end: "13:00" };
    expect(quietUntil(at("2027-01-15T11:30:00Z"), lunch)?.toISOString()).toBe(
      "2027-01-15T12:00:00.000Z",
    );
    expect(quietUntil(at("2027-01-15T12:30:00Z"), lunch)).toBeNull();
  });

  it("treats a missing window or start === end as no quiet hours", () => {
    expect(quietUntil(at("2027-01-15T23:00:00Z"), null)).toBeNull();
    expect(quietUntil(at("2027-01-15T23:00:00Z"), { start: "08:00", end: "08:00" })).toBeNull();
  });
});
