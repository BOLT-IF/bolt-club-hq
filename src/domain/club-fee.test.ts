import { describe, expect, it } from "vitest";

import {
  formatClubYear,
  inferClubYear,
  inferClubYearFromDate,
  inferTermSeason,
  resolveTermMembershipPeriod,
} from "./club-fee";

describe("club-fee domain helpers", () => {
  it("infers season from YYYY-MM-DD startsOn (Jan-Jun spring, Jul-Dec fall)", () => {
    expect(inferTermSeason("2026-01-01")).toBe("spring");
    expect(inferTermSeason("2026-06-30")).toBe("spring");
    expect(inferTermSeason("2026-07-01")).toBe("fall");
    expect(inferTermSeason("2026-08-25")).toBe("fall");
    expect(inferTermSeason("2026-12-31")).toBe("fall");
  });

  it("infers clubYear so Fall Y and Spring Y+1 share clubYear Y", () => {
    expect(inferClubYear("2026-08-25")).toBe(2026);
    expect(inferClubYear("2027-01-11")).toBe(2026);
    expect(inferClubYear("2027-06-15", "spring")).toBe(2026);
    expect(inferClubYear("2027-06-15", "fall")).toBe(2027);
  });

  it("infers clubYear and season from a Date using Stockholm local time", () => {
    // 2026-06-30T22:30:00Z is 2026-07-01T00:30 in Europe/Stockholm (UTC+2 in summer) -> fall 2026
    expect(inferClubYearFromDate(new Date("2026-06-30T22:30:00Z"))).toEqual({
      clubYear: 2026,
      season: "fall",
    });
    // 2026-12-31T23:30:00Z is 2027-01-01T00:30 in Europe/Stockholm (UTC+1 in winter) -> spring 2026
    expect(inferClubYearFromDate(new Date("2026-12-31T23:30:00Z"))).toEqual({
      clubYear: 2026,
      season: "spring",
    });
  });

  it("resolves term membership period using explicit values when set and falling back to startsOn", () => {
    expect(
      resolveTermMembershipPeriod({ startsOn: "2027-01-11", season: null, clubYear: null }),
    ).toEqual({ season: "spring", clubYear: 2026 });
    expect(
      resolveTermMembershipPeriod({ startsOn: "2027-01-11", season: "fall", clubYear: 2027 }),
    ).toEqual({ season: "fall", clubYear: 2027 });
    expect(
      resolveTermMembershipPeriod({ startsOn: "2027-01-11", season: "fall", clubYear: null }),
    ).toEqual({ season: "fall", clubYear: 2027 });
    expect(
      resolveTermMembershipPeriod({ startsOn: "2027-01-11", season: null, clubYear: 2025 }),
    ).toEqual({ season: "spring", clubYear: 2025 });
  });

  it("formats clubYear as YYYY/YYYY+1", () => {
    expect(formatClubYear(2026)).toBe("2026/2027");
  });
});
