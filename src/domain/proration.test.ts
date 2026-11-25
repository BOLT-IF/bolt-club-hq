import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { computePassOffer, passTermsNotice, roundHalfUpRatio } from "./proration";

describe("proration (PLAN §6.5)", () => {
  it("computes the proration table with round half-up", () => {
    const cases: Array<{
      passPrice: number;
      remaining: number;
      total: number;
      expected: number;
    }> = [
      { passPrice: 1800, remaining: 10, total: 10, expected: 1800 },
      { passPrice: 1800, remaining: 5, total: 10, expected: 900 },
      { passPrice: 101, remaining: 1, total: 2, expected: 51 }, // 50.5 -> 51
      { passPrice: 1, remaining: 1, total: 2, expected: 1 }, // 0.5 -> 1
      { passPrice: 3, remaining: 1, total: 2, expected: 2 }, // 1.5 -> 2
      { passPrice: 10, remaining: 1, total: 4, expected: 3 }, // 2.5 -> 3
      { passPrice: 100, remaining: 1, total: 3, expected: 33 }, // 33.33 -> 33
      { passPrice: 100, remaining: 2, total: 3, expected: 67 }, // 66.67 -> 67
      { passPrice: 1500, remaining: 1, total: 7, expected: 214 }, // 214.28 -> 214
      { passPrice: 1500, remaining: 6, total: 7, expected: 1286 }, // 1285.71 -> 1286
      { passPrice: 0, remaining: 4, total: 8, expected: 0 },
    ];

    for (const c of cases) {
      expect(roundHalfUpRatio(c.passPrice, c.remaining, c.total)).toBe(c.expected);
    }
  });

  it("does not offer a pass when 0 events remain or total is 0", () => {
    expect(computePassOffer({ passPrice: 1800, remainingEvents: 0, totalEvents: 10 })).toEqual({
      offered: false,
      reason: "no_events_remaining",
    });
    expect(computePassOffer({ passPrice: 1800, remainingEvents: 0, totalEvents: 0 })).toEqual({
      offered: false,
      reason: "no_events_remaining",
    });
  });

  it("offers a prorated integer price when events remain", () => {
    expect(computePassOffer({ passPrice: 101, remainingEvents: 1, totalEvents: 2 })).toEqual({
      offered: true,
      priceSek: 51,
      remainingEvents: 1,
      totalEvents: 2,
    });
  });

  it("rejects negative, fractional or impossible counts", () => {
    expect(() => roundHalfUpRatio(-100, 1, 2)).toThrow(RangeError);
    expect(() => roundHalfUpRatio(100.5, 1, 2)).toThrow(RangeError);
    expect(() => roundHalfUpRatio(100, 1, 0)).toThrow(RangeError);
    expect(() => computePassOffer({ passPrice: 100, remainingEvents: 5, totalEvents: 4 })).toThrow(
      RangeError,
    );
  });

  it("formats the pre-purchase terms notice", () => {
    expect(passTermsNotice(12)).toBe(
      "Covers up to 12 sessions; no refunds; cancelled nights not compensated.",
    );
    expect(passTermsNotice(1)).toBe(
      "Covers up to 1 sessions; no refunds; cancelled nights not compensated.",
    );
  });

  it("satisfies monotonicity, bounds and half-up properties (fast-check)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 0, max: 60 }),
        (passPrice, total, rawRemaining) => {
          const remaining = rawRemaining % (total + 1);
          const price = roundHalfUpRatio(passPrice, remaining, total);
          expect(Number.isSafeInteger(price)).toBe(true);
          expect(price).toBeGreaterThanOrEqual(0);
          expect(price).toBeLessThanOrEqual(passPrice);
          if (remaining === total) expect(price).toBe(passPrice);
          if (remaining === 0) expect(price).toBe(0);
          if (remaining < total) {
            expect(roundHalfUpRatio(passPrice, remaining + 1, total)).toBeGreaterThanOrEqual(price);
          }
          // Half-up: diff in [-0.5, +0.5], and exact .5 always rounds up.
          const num = passPrice * remaining;
          const rem = num % total;
          const floorVal = Math.floor(num / total);
          expect(price).toBe(2 * rem >= total ? floorVal + 1 : floorVal);
        },
      ),
    );
  });
});
