import { describe, expect, it } from "vitest";

import basicGolden from "../../../contracts/roster-import-v1/golden/basic.json";
import fullNameMatchGolden from "../../../contracts/roster-import-v1/golden/full-name-match.json";
import guestsGolden from "../../../contracts/roster-import-v1/golden/guests.json";
import matchCaseGolden from "../../../contracts/roster-import-v1/golden/match-case.json";
import {
  buildRosterImportPayload,
  buildRosterImportUrl,
  decodeRosterImportFragment,
  encodeRosterImportPayload,
} from "./index";

describe("roster-link domain (S8.3)", () => {
  it("output matches the golden fixtures byte for byte, after decoding", () => {
    const basic = basicGolden;
    const basicUrl = buildRosterImportUrl(
      "https://roster.example.se",
      {
        title: "Thu Mixed Doubles",
        startsAt: new Date("2027-01-14T18:00:00Z"),
        format: "XD",
      },
      [
        {
          name: "Elin Varga",
          rosterName: null,
          guest: false,
          tier: 1,
          confirmedAt: new Date("2027-01-10T10:00:00Z"),
        },
        {
          name: "Marko Hale",
          rosterName: null,
          guest: false,
          tier: 1,
          confirmedAt: new Date("2027-01-10T10:01:00Z"),
        },
        {
          name: "Tove Sandqvist",
          rosterName: null,
          guest: false,
          tier: 2,
          confirmedAt: new Date("2027-01-10T10:02:00Z"),
        },
      ],
    );
    expect(basicUrl.startsWith("https://roster.example.se/planner#import=")).toBe(true);
    const basicDecoded = decodeRosterImportFragment(basicUrl.split("#import=")[1]!);
    expect(basicDecoded).toEqual(basic);
    expect(JSON.stringify(basicDecoded)).toBe(JSON.stringify(basic));

    const fullNameMatch = fullNameMatchGolden;
    const fullNameUrl = buildRosterImportUrl(
      "https://roster.example.se/",
      {
        title: "Full Name Match",
        startsAt: new Date("2027-01-15T18:00:00Z"),
      },
      [
        {
          name: "Tove Sandqvist",
          rosterName: "Sandy",
          guest: false,
          tier: 1,
          confirmedAt: new Date("2027-01-11T10:00:00Z"),
        },
      ],
    );
    expect(fullNameUrl.startsWith("https://roster.example.se/planner#import=")).toBe(true);
    const fullNameDecoded = decodeRosterImportFragment(fullNameUrl.split("#import=")[1]!);
    expect(fullNameDecoded).toEqual(fullNameMatch);
    expect(JSON.stringify(fullNameDecoded)).toBe(JSON.stringify(fullNameMatch));

    const guests = guestsGolden;
    const guestsUrl = buildRosterImportUrl(
      "https://roster.example.se",
      {
        title: "Sat Social Doubles",
        startsAt: new Date("2027-01-16T10:00:00Z"),
        format: "MD",
      },
      [
        {
          name: "Kasia Nowak",
          rosterName: null,
          guest: false,
          tier: 1,
          confirmedAt: new Date("2027-01-12T10:00:00Z"),
        },
        {
          name: "Hugo Dahl",
          guest: true,
          tier: 3,
          confirmedAt: new Date("2027-01-12T10:01:00Z"),
        },
        {
          name: "Lena Pruitt",
          guest: true,
          tier: 3,
          confirmedAt: new Date("2027-01-12T10:02:00Z"),
        },
      ],
    );
    const guestsDecoded = decodeRosterImportFragment(guestsUrl.split("#import=")[1]!);
    expect(guestsDecoded).toEqual(guests);
    expect(JSON.stringify(guestsDecoded)).toBe(JSON.stringify(guests));

    const matchCase = matchCaseGolden;
    const matchCaseUrl = buildRosterImportUrl(
      "https://roster.example.se",
      {
        title: "Case Test",
        startsAt: new Date("2027-01-15T18:00:00Z"),
      },
      [
        {
          name: "ELIN VARGA",
          rosterName: "ELIN",
          guest: false,
          tier: 1,
          confirmedAt: new Date("2027-01-11T10:00:00Z"),
        },
      ],
    );
    const matchCaseDecoded = decodeRosterImportFragment(matchCaseUrl.split("#import=")[1]!);
    expect(matchCaseDecoded).toEqual(matchCase);
    expect(JSON.stringify(matchCaseDecoded)).toBe(JSON.stringify(matchCase));
  });

  it("short uses roster_name, falling back to the first name", () => {
    const payload = buildRosterImportPayload(
      { title: "Session", startsAt: new Date("2027-02-01T18:00:00Z"), format: "XD" },
      [
        {
          name: "Ashok Bommisetti",
          rosterName: "Ashok B",
          guest: false,
          tier: 1,
          confirmedAt: new Date("2027-01-20T10:00:00Z"),
        },
        {
          name: "Sven Lindqvist",
          rosterName: "   ",
          guest: false,
          tier: 1,
          confirmedAt: new Date("2027-01-20T10:01:00Z"),
        },
        {
          name: "Maria",
          rosterName: null,
          guest: false,
          tier: 1,
          confirmedAt: new Date("2027-01-20T10:02:00Z"),
        },
      ],
    );

    expect(payload.players).toEqual([
      { name: "Ashok Bommisetti", short: "Ashok B", guest: false },
      { name: "Sven Lindqvist", short: "Sven", guest: false },
      { name: "Maria", short: "Maria", guest: false },
    ]);
  });

  it("flags guests and ignores rosterName on guests", () => {
    const payload = buildRosterImportPayload(
      { title: "Open Play", startsAt: new Date("2027-02-01T18:00:00Z") },
      [
        {
          name: "Hugo Dahl",
          rosterName: "ShouldBeIgnored",
          guest: true,
          tier: 3,
          confirmedAt: new Date("2027-01-20T10:00:00Z"),
        },
      ],
    );

    expect(payload.players).toEqual([{ name: "Hugo Dahl", short: "Hugo", guest: true }]);
  });

  it("orders players by tier, then confirmation time", () => {
    const payload = buildRosterImportPayload(
      { title: "Tiered Session", startsAt: new Date("2027-02-01T18:00:00Z"), format: "XD" },
      [
        {
          name: "Guest One",
          guest: true,
          tier: 3,
          confirmedAt: new Date("2027-01-01T08:00:00Z"),
        },
        {
          name: "Adhoc Late",
          guest: false,
          tier: 2,
          confirmedAt: new Date("2027-01-01T12:00:00Z"),
        },
        {
          name: "Pass Second",
          guest: false,
          tier: 1,
          confirmedAt: new Date("2027-01-01T11:00:00Z"),
        },
        {
          name: "Adhoc Early",
          guest: false,
          tier: 2,
          confirmedAt: new Date("2027-01-01T09:00:00Z"),
        },
        {
          name: "Pass First",
          guest: false,
          tier: 1,
          confirmedAt: new Date("2027-01-01T10:00:00Z"),
        },
      ],
    );

    expect(payload.players.map((p) => p.name)).toEqual([
      "Pass First",
      "Pass Second",
      "Adhoc Early",
      "Adhoc Late",
      "Guest One",
    ]);
  });

  it("keeps a 30-player event under 2,000 characters", () => {
    const players = Array.from({ length: 30 }, (_, i) => ({
      name: `P${String(i + 1).padStart(2, "0")} A`,
      rosterName: `P${String(i + 1).padStart(2, "0")}`,
      guest: false,
      tier: 1,
      confirmedAt: new Date(Date.UTC(2027, 0, 10, 10, i)),
    }));
    const payload = buildRosterImportPayload(
      { title: "Thu Mixed", startsAt: new Date("2027-01-14T18:00:00Z"), format: "XD" },
      players,
    );
    const fragment = encodeRosterImportPayload(payload);
    expect(fragment.length).toBeLessThan(2000);
  });
});
