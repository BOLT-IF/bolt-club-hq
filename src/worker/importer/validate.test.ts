import { describe, expect, it } from "vitest";

import { MAX_AMOUNT_SEK } from "../../domain/ledger";
import { MAX_IMPORT_ROWS, validateImportBody } from "./validate";

describe("validateImportBody", () => {
  it("accepts a valid payload and normalizes fields", () => {
    const res = validateImportBody({
      rows: [
        {
          displayName: "  Ada Lovelace  ",
          email: "  Ada@Club.Test ",
          rosterName: "  Ada L ",
          openingBalanceSek: 250,
          paymentRef: " bc-ada1 ",
          note: "  Carry over  ",
        },
        {
          displayName: "Grace",
          email: "grace@club.test",
          rosterName: "   ",
          role: "admin",
          status: "inactive",
          openingBalanceSek: -100,
        },
      ],
    });
    expect(res).toEqual({
      ok: true,
      rows: [
        {
          row: 0,
          displayName: "Ada Lovelace",
          email: "ada@club.test",
          rosterName: "Ada L",
          role: "member",
          status: "active",
          paymentRef: "BC-ADA1",
          openingBalanceSek: 250,
          note: "Carry over",
        },
        {
          row: 1,
          displayName: "Grace",
          email: "grace@club.test",
          rosterName: null,
          role: "admin",
          status: "inactive",
          paymentRef: null,
          openingBalanceSek: -100,
          note: "Opening balance import",
        },
      ],
    });
  });

  it("rejects non-objects, unknown top-level keys, empty rows, and oversized batches", () => {
    expect(validateImportBody(null)).toEqual({ ok: false, error: "invalid_body", errors: [] });
    expect(validateImportBody([])).toEqual({ ok: false, error: "invalid_body", errors: [] });
    expect(validateImportBody({ rows: [] })).toEqual({
      ok: false,
      error: "invalid_body",
      errors: [],
    });
    expect(
      validateImportBody({
        rows: [{ displayName: "A", email: "a@b.se", openingBalanceSek: 0 }],
        extra: 1,
      }),
    ).toEqual({
      ok: false,
      error: "invalid_body",
      errors: [],
    });
    const tooMany = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({
      displayName: `M${String(i)}`,
      email: `m${String(i)}@club.test`,
      openingBalanceSek: 0,
    }));
    expect(validateImportBody({ rows: tooMany })).toEqual({
      ok: false,
      error: "invalid_body",
      errors: [],
    });
  });

  it("reports all per-row validation errors together", () => {
    const res = validateImportBody({
      rows: [
        {
          displayName: "",
          email: "bad",
          rosterName: "x".repeat(41),
          role: "owner",
          status: "pending",
          paymentRef: "no_underscores",
          openingBalanceSek: 12.34,
          note: "n".repeat(501),
          bogus: true,
        },
        {
          displayName: "Overflow",
          email: "ok@club.test",
          openingBalanceSek: MAX_AMOUNT_SEK + 1,
        },
        {
          displayName: "Dup",
          email: "OK@club.test",
          paymentRef: "BC-1234",
          openingBalanceSek: "100",
        },
        {
          displayName: "DupRef",
          email: "other@club.test",
          paymentRef: "bc-1234",
          openingBalanceSek: 0,
        },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("invalid_import_rows");
    expect(res.errors).toEqual(
      expect.arrayContaining([
        { row: 0, field: "bogus", error: "unknown_field" },
        { row: 0, field: "displayName", error: "invalid_display_name" },
        { row: 0, field: "email", error: "invalid_email" },
        { row: 0, field: "rosterName", error: "invalid_roster_name" },
        { row: 0, field: "role", error: "invalid_role" },
        { row: 0, field: "status", error: "invalid_status" },
        { row: 0, field: "paymentRef", error: "invalid_payment_ref" },
        { row: 0, field: "openingBalanceSek", error: "invalid_amount" },
        { row: 0, field: "note", error: "invalid_note" },
        { row: 1, field: "openingBalanceSek", error: "invalid_amount" },
        { row: 2, field: "email", error: "duplicate_email" },
        { row: 2, field: "openingBalanceSek", error: "invalid_amount" },
        { row: 3, field: "paymentRef", error: "duplicate_payment_ref" },
      ]),
    );
  });
});
