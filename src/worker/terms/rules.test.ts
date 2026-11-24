import { describe, expect, it } from "vitest";

import { canTransition, derivePassCap, TERM_STATUSES, type TermStatus } from "./rules";

describe("term status machine", () => {
  const allowed: ReadonlyArray<readonly [TermStatus, TermStatus]> = [
    ["draft", "open_for_passes"],
    ["open_for_passes", "active"],
    ["active", "closed"],
  ];

  it("allows only the forward steps draft → open_for_passes → active → closed", () => {
    for (const from of TERM_STATUSES) {
      for (const to of TERM_STATUSES) {
        const expected = allowed.some(([a, b]) => a === from && b === to);
        expect(canTransition(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
  });

  it("rejects skipping a step, going back and staying put", () => {
    expect(canTransition("draft", "active")).toBe(false);
    expect(canTransition("draft", "closed")).toBe(false);
    expect(canTransition("open_for_passes", "draft")).toBe(false);
    expect(canTransition("closed", "active")).toBe(false);
    expect(canTransition("active", "active")).toBe(false);
  });
});

describe("derivePassCap (A8: minimum capacity across the series' events)", () => {
  it("uses the series capacity while no events exist", () => {
    expect(derivePassCap(12, [])).toBe(12);
  });

  it("uses the smallest event capacity once events exist", () => {
    expect(derivePassCap(12, [12, 8, 10])).toBe(8);
  });

  it("follows the events even when they are above the series default", () => {
    expect(derivePassCap(12, [14, 14])).toBe(14);
  });
});
