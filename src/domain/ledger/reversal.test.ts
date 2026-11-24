import { describe, expect, it } from "vitest";

import { LedgerError, planReversal } from "./index";

const charge = { id: "c1", kind: "charge", amountSek: 150 } as const;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  return "no error";
}

describe("planReversal", () => {
  it("returns the negated amount of the original", () => {
    expect(planReversal(charge, [])).toBe(-150);
    expect(planReversal({ id: "p1", kind: "payment", amountSek: -150 }, [])).toBe(150);
    expect(planReversal({ id: "a1", kind: "adjustment", amountSek: -20 }, [])).toBe(20);
  });

  it("refuses to reverse a reversal", () => {
    expect(codeOf(() => planReversal({ id: "r1", kind: "reversal", amountSek: -150 }, []))).toBe(
      "cannot_reverse_reversal",
    );
  });

  it("refuses to reverse the same entry twice", () => {
    expect(codeOf(() => planReversal(charge, ["r1"]))).toBe("already_reversed");
  });
});
