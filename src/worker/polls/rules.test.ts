import { describe, expect, it } from "vitest";

import {
  canSeeResults,
  isClosed,
  parseCreate,
  parsePatch,
  validateChoice,
  type PollRules,
} from "./rules";

const NOW = new Date("2027-03-01T12:00:00Z");
const poll = (over: Partial<PollRules> = {}): PollRules => ({
  multiChoice: false,
  closesAt: new Date("2027-03-02T12:00:00Z"),
  resultsVisibility: "always",
  ...over,
});
const OPTIONS = ["a", "b", "c"];

describe("validateChoice", () => {
  it("single choice needs exactly one option", () => {
    expect(validateChoice(poll(), OPTIONS, ["a"])).toEqual({ ok: true, optionIds: ["a"] });
    expect(validateChoice(poll(), OPTIONS, ["a", "b"])).toEqual({
      ok: false,
      error: "single_choice",
    });
    expect(validateChoice(poll(), OPTIONS, [])).toEqual({ ok: false, error: "no_choice" });
  });

  it("multi choice takes one or more distinct options", () => {
    const multi = poll({ multiChoice: true });
    expect(validateChoice(multi, OPTIONS, ["c", "a"])).toEqual({ ok: true, optionIds: ["c", "a"] });
    expect(validateChoice(multi, OPTIONS, [])).toEqual({ ok: false, error: "no_choice" });
    expect(validateChoice(multi, OPTIONS, ["a", "a"])).toEqual({
      ok: false,
      error: "duplicate_option",
    });
  });

  it("rejects options from another poll and non-string input", () => {
    expect(validateChoice(poll(), OPTIONS, ["zzz"])).toEqual({
      ok: false,
      error: "unknown_option",
    });
    expect(validateChoice(poll(), OPTIONS, "a")).toEqual({ ok: false, error: "invalid_body" });
    expect(validateChoice(poll(), OPTIONS, [1])).toEqual({ ok: false, error: "invalid_body" });
  });
});

describe("isClosed", () => {
  it("is closed at and after closesAt, never without one", () => {
    expect(isClosed(poll(), NOW)).toBe(false);
    expect(isClosed(poll({ closesAt: NOW }), NOW)).toBe(true);
    expect(isClosed(poll({ closesAt: new Date("2027-01-01T00:00:00Z") }), NOW)).toBe(true);
    expect(isClosed(poll({ closesAt: null }), NOW)).toBe(false);
  });
});

describe("canSeeResults", () => {
  const closed = { closesAt: new Date("2027-02-01T00:00:00Z") };
  const member = { isAdmin: false, hasVoted: false };
  const voter = { isAdmin: false, hasVoted: true };
  const admin = { isAdmin: true, hasVoted: false };

  it("always: everyone", () => {
    expect(canSeeResults(poll(), member, NOW)).toBe(true);
  });

  it("after_vote: once you voted, or once the poll closed", () => {
    const p = poll({ resultsVisibility: "after_vote" });
    expect(canSeeResults(p, member, NOW)).toBe(false);
    expect(canSeeResults(p, voter, NOW)).toBe(true);
    expect(canSeeResults({ ...p, ...closed }, member, NOW)).toBe(true);
  });

  it("after_close: only after close, even for voters", () => {
    const p = poll({ resultsVisibility: "after_close" });
    expect(canSeeResults(p, voter, NOW)).toBe(false);
    expect(canSeeResults({ ...p, ...closed }, member, NOW)).toBe(true);
  });

  it("admins: members never, even after close", () => {
    const p = poll({ resultsVisibility: "admins", ...closed });
    expect(canSeeResults(p, voter, NOW)).toBe(false);
    expect(canSeeResults(p, admin, NOW)).toBe(true);
  });

  it("admins see results in every mode", () => {
    for (const v of ["always", "after_vote", "after_close", "admins"] as const) {
      expect(canSeeResults(poll({ resultsVisibility: v }), admin, NOW)).toBe(true);
    }
  });
});

describe("parseCreate", () => {
  const base = { question: " Kit colour? ", options: ["Red", " Blue "] };

  it("trims and applies defaults", () => {
    expect(parseCreate(base, NOW)).toEqual({
      ok: true,
      value: {
        question: "Kit colour?",
        options: ["Red", "Blue"],
        multiChoice: false,
        anonymous: false,
        resultsVisibility: "always",
        closesAt: null,
      },
    });
  });

  it("accepts every setting", () => {
    const r = parseCreate(
      {
        ...base,
        multiChoice: true,
        anonymous: true,
        resultsVisibility: "after_close",
        closesAt: "2027-03-05T18:00:00.000Z",
      },
      NOW,
    );
    expect(r.ok && r.value.closesAt?.toISOString()).toBe("2027-03-05T18:00:00.000Z");
  });

  it("rejects bad input", () => {
    const bad = [
      null,
      { ...base, question: "  " },
      { ...base, options: ["Only one"] },
      { ...base, options: ["Same", "same "] },
      { ...base, options: ["A", ""] },
      { ...base, options: Array.from({ length: 21 }, (_, i) => `o${String(i)}`) },
      { ...base, resultsVisibility: "never" },
      { ...base, closesAt: "not a date" },
      { ...base, closesAt: "2027-02-01T00:00:00Z" }, // in the past
      { ...base, anonymous: "yes" },
      { ...base, extra: 1 },
    ];
    for (const body of bad) expect(parseCreate(body, NOW).ok, JSON.stringify(body)).toBe(false);
  });
});

describe("parsePatch", () => {
  it("allows question, closing and visibility changes", () => {
    expect(parsePatch({ question: "New?" }, NOW)).toEqual({
      ok: true,
      value: { question: "New?" },
    });
    expect(parsePatch({ close: true }, NOW)).toEqual({ ok: true, value: { closesAt: NOW } });
    expect(parsePatch({ closesAt: null }, NOW)).toEqual({ ok: true, value: { closesAt: null } });
    expect(parsePatch({ resultsVisibility: "admins" }, NOW)).toEqual({
      ok: true,
      value: { resultsVisibility: "admins" },
    });
  });

  it("never changes anonymity, choice mode or options after creation", () => {
    for (const body of [{ anonymous: false }, { multiChoice: true }, { options: ["x", "y"] }, {}]) {
      expect(parsePatch(body, NOW).ok, JSON.stringify(body)).toBe(false);
    }
  });
});
