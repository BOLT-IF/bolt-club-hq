import { describe, expect, it } from "vitest";

import { entryAmount, LedgerError, MAX_AMOUNT_SEK } from "./index";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  return "no error";
}

describe("ledger amounts are whole kronor integers", () => {
  it("accepts whole positive kronor and signs them by kind", () => {
    expect(entryAmount("charge", 150)).toBe(150);
    expect(entryAmount("payment", 150)).toBe(-150);
    expect(entryAmount("adjustment", -40)).toBe(-40);
    expect(entryAmount("adjustment", 40)).toBe(40);
  });

  it.each([1.5, 0.1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects the non-integer %s",
    (value) => {
      for (const kind of ["charge", "payment", "adjustment"] as const) {
        expect(codeOf(() => entryAmount(kind, value))).toBe("invalid_amount");
      }
    },
  );

  it.each(["10", null, undefined, {}, [], true, 10n])("rejects the non-number %s", (value) => {
    expect(codeOf(() => entryAmount("charge", value))).toBe("invalid_amount");
  });

  it("rejects zero, and a negative charge or payment (the kind decides the sign)", () => {
    for (const kind of ["charge", "payment", "adjustment"] as const) {
      expect(codeOf(() => entryAmount(kind, 0))).toBe("invalid_amount");
    }
    expect(codeOf(() => entryAmount("charge", -5))).toBe("invalid_amount");
    expect(codeOf(() => entryAmount("payment", -5))).toBe("invalid_amount");
  });

  it("rejects what the integer column cannot hold", () => {
    expect(MAX_AMOUNT_SEK).toBe(2_147_483_647);
    expect(entryAmount("charge", MAX_AMOUNT_SEK)).toBe(MAX_AMOUNT_SEK);
    expect(codeOf(() => entryAmount("charge", MAX_AMOUNT_SEK + 1))).toBe("invalid_amount");
    expect(codeOf(() => entryAmount("adjustment", -(MAX_AMOUNT_SEK + 1)))).toBe("invalid_amount");
    expect(codeOf(() => entryAmount("charge", Number.MAX_SAFE_INTEGER))).toBe("invalid_amount");
  });
});
