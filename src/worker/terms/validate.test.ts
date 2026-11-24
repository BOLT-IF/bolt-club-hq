import { describe, expect, it } from "vitest";

import {
  CAPTAIN_EDITABLE_FIELDS,
  parseCaptainIds,
  parseClone,
  parseSeriesCreate,
  parseSeriesPatch,
  parseTermCreate,
  parseTermPatch,
} from "./validate";

const validSeries = {
  termId: "t1",
  name: "Thursday XD",
  format: "XD",
  weekday: 4,
  startTime: "19:00",
  durationMin: 90,
  capacity: 16,
  passPrice: 1800,
  adhocFee: 120,
};

describe("term input", () => {
  it("accepts a name and a real date range", () => {
    const parsed = parseTermCreate({ name: "Spring 2027", startsOn: "2027-01-11", endsOn: "2027-06-24" });
    expect(parsed.ok).toBe(true);
  });

  it("rejects impossible dates, reversed ranges and blank names", () => {
    expect(parseTermCreate({ name: "x", startsOn: "2027-02-30", endsOn: "2027-06-01" }).ok).toBe(false);
    expect(parseTermCreate({ name: "x", startsOn: "2027-06-02", endsOn: "2027-06-01" }).ok).toBe(false);
    expect(parseTermCreate({ name: "  ", startsOn: "2027-01-01", endsOn: "2027-06-01" }).ok).toBe(false);
    expect(parseTermCreate(null).ok).toBe(false);
  });

  it("a patch accepts a status but rejects an unknown one and unknown fields", () => {
    expect(parseTermPatch({ status: "open_for_passes" }).ok).toBe(true);
    expect(parseTermPatch({ status: "archived" }).ok).toBe(false);
    expect(parseTermPatch({ nope: 1 }).ok).toBe(false);
  });
});

describe("series input", () => {
  it("applies the plan defaults: 1 guest per member, RSVP closes 24h before", () => {
    const parsed = parseSeriesCreate(validSeries);
    expect(parsed.ok && parsed.value.maxGuestsDefault).toBe(1);
    expect(parsed.ok && parsed.value.rsvpCloseOffsetMin).toBe(1440);
  });

  it("keeps money as whole kronor: floats and negatives are rejected", () => {
    expect(parseSeriesCreate({ ...validSeries, passPrice: 1800.5 }).ok).toBe(false);
    expect(parseSeriesCreate({ ...validSeries, adhocFee: -1 }).ok).toBe(false);
  });

  it("weekday is ISO 1 (Monday) to 7 (Sunday); time is HH:MM", () => {
    expect(parseSeriesCreate({ ...validSeries, weekday: 0 }).ok).toBe(false);
    expect(parseSeriesCreate({ ...validSeries, weekday: 8 }).ok).toBe(false);
    expect(parseSeriesCreate({ ...validSeries, weekday: 7 }).ok).toBe(true);
    expect(parseSeriesCreate({ ...validSeries, startTime: "7pm" }).ok).toBe(false);
    expect(parseSeriesCreate({ ...validSeries, startTime: "24:00" }).ok).toBe(false);
  });

  it("rejects an unknown format and a zero capacity", () => {
    expect(parseSeriesCreate({ ...validSeries, format: "singles" }).ok).toBe(false);
    expect(parseSeriesCreate({ ...validSeries, capacity: 0 }).ok).toBe(false);
  });

  it("a patch takes the override flag and never a term change", () => {
    expect(parseSeriesPatch({ capacity: 10, overrideCapBelowSold: true }).ok).toBe(true);
    expect(parseSeriesPatch({ termId: "t2" }).ok).toBe(false);
  });

  it("captains may edit only operational fields", () => {
    expect([...CAPTAIN_EDITABLE_FIELDS].sort()).toEqual(
      ["location", "maxGuestsDefault", "rsvpCloseOffsetMin"].sort(),
    );
  });
});

describe("captain ids", () => {
  it("takes a list of ids, dropping duplicates", () => {
    const parsed = parseCaptainIds({ memberIds: ["a", "b", "a"] });
    expect(parsed.ok && parsed.value).toEqual(["a", "b"]);
  });

  it("rejects a non-list", () => {
    expect(parseCaptainIds({ memberIds: "a" }).ok).toBe(false);
    expect(parseCaptainIds({}).ok).toBe(false);
  });
});

describe("clone input", () => {
  it("needs the new term's dates; the name is optional", () => {
    const parsed = parseClone({ startsOn: "2027-07-05", endsOn: "2027-12-20" });
    expect(parsed.ok && parsed.value.name).toBeUndefined();
    expect(parseClone({ name: "Autumn", startsOn: "2027-07-05", endsOn: "2027-12-20" }).ok).toBe(true);
  });

  it("rejects a missing or reversed range", () => {
    expect(parseClone({ name: "Autumn" }).ok).toBe(false);
    expect(parseClone({ startsOn: "2027-12-20", endsOn: "2027-07-05" }).ok).toBe(false);
  });
});
