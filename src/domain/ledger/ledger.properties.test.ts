import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  balanceOf,
  entryAmount,
  itemize,
  LedgerError,
  planReversal,
  type LedgerRow,
} from "./index";

/**
 * Builds a ledger by replaying random operations through the same domain rules the
 * service uses (entryAmount, planReversal), so every generated ledger is a legal one.
 */
type Op =
  | { t: "charge"; amount: number; dt: number }
  | { t: "payment"; amount: number; dt: number }
  | { t: "adjust"; amount: number; dt: number }
  | { t: "reverse"; pick: number; dt: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant("charge" as const), amount: fc.integer({ min: 1, max: 500 }), dt: fc.nat(3) }),
  fc.record({ t: fc.constant("payment" as const), amount: fc.integer({ min: 1, max: 500 }), dt: fc.nat(3) }),
  fc.record({
    t: fc.constant("adjust" as const),
    amount: fc.integer({ min: -300, max: 300 }).filter((v) => v !== 0),
    dt: fc.nat(3),
  }),
  fc.record({ t: fc.constant("reverse" as const), pick: fc.nat(1000), dt: fc.nat(3) }),
);

function replay(ops: readonly Op[]): LedgerRow[] {
  const rows: LedgerRow[] = [];
  let now = 0;
  for (const [index, op] of ops.entries()) {
    now += op.dt;
    const id = `e${String(index).padStart(4, "0")}`;
    if (op.t === "reverse") {
      const target = rows[op.pick % Math.max(rows.length, 1)];
      if (!target) continue;
      const reversedBy = rows.filter((r) => r.reversesEntryId === target.id).map((r) => r.id);
      try {
        const amountSek = planReversal(target, reversedBy);
        rows.push({
          id,
          kind: "reversal",
          amountSek,
          reason: target.reason,
          createdAt: now,
          reversesEntryId: target.id,
        });
      } catch (error) {
        if (!(error instanceof LedgerError)) throw error;
      }
      continue;
    }
    const kind = op.t === "adjust" ? "adjustment" : op.t;
    rows.push({
      id,
      kind,
      amountSek: entryAmount(kind, op.amount),
      reason: kind === "payment" ? "payment" : "manual",
      createdAt: now,
      reversesEntryId: null,
    });
  }
  return rows;
}

const ledgerArb = fc.array(opArb, { maxLength: 40 }).map(replay);
const RUNS = { numRuns: 400 };

describe("ledger properties (fast-check)", () => {
  it("the balance always equals the sum of entries", () => {
    fc.assert(
      fc.property(ledgerArb, (rows) => {
        const sum = rows.reduce((acc, r) => acc + r.amountSek, 0);
        expect(balanceOf(rows)).toBe(sum);
        expect(itemize(rows).balanceSek).toBe(sum);
      }),
      RUNS,
    );
  });

  it("owed and credit are the two halves of the balance, never both non-zero", () => {
    fc.assert(
      fc.property(ledgerArb, (rows) => {
        const { balanceSek, owedSek, creditSek } = itemize(rows);
        expect(owedSek - creditSek).toBe(balanceSek);
        expect(owedSek * creditSek).toBe(0);
        expect(owedSek).toBeGreaterThanOrEqual(0);
        expect(creditSek).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });

  it("allocation is conserved: money allocated to charges equals credit applied, and amounts add up", () => {
    fc.assert(
      fc.property(ledgerArb, (rows) => {
        const result = itemize(rows);
        let debitAllocated = 0;
        let creditAllocated = 0;
        let debitOutstanding = 0;
        let creditOutstanding = 0;
        for (const item of result.items) {
          if (item.status === "reversed" || item.status === "reversal") {
            expect(item.allocatedSek).toBe(0);
            expect(item.outstandingSek).toBe(0);
            continue;
          }
          expect(item.allocatedSek + item.outstandingSek).toBe(Math.abs(item.entry.amountSek));
          expect(item.allocatedSek).toBeGreaterThanOrEqual(0);
          expect(item.outstandingSek).toBeGreaterThanOrEqual(0);
          if (item.entry.amountSek > 0) {
            debitAllocated += item.allocatedSek;
            debitOutstanding += item.outstandingSek;
          } else {
            creditAllocated += item.allocatedSek;
            creditOutstanding += item.outstandingSek;
          }
        }
        expect(debitAllocated).toBe(creditAllocated);
        expect(debitOutstanding).toBe(result.owedSek);
        expect(creditOutstanding).toBe(result.creditSek);
      }),
      RUNS,
    );
  });

  it("FIFO: a charge is never partly paid while an older charge is unpaid", () => {
    fc.assert(
      fc.property(ledgerArb, (rows) => {
        const debits = itemize(rows).items.filter(
          (i) => i.entry.amountSek > 0 && i.status !== "reversed" && i.status !== "reversal",
        );
        let sawUnpaid = false;
        for (const item of debits) {
          if (sawUnpaid) expect(item.allocatedSek).toBe(0);
          if (item.outstandingSek > 0) sawUnpaid = true;
        }
      }),
      RUNS,
    );
  });

  it("the result does not depend on the order the entries are passed in", () => {
    fc.assert(
      fc.property(ledgerArb, fc.infiniteStream(fc.nat()), (rows, stream) => {
        const shuffled = [...rows];
        const picks = stream[Symbol.iterator]();
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = picks.next().value % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        expect(itemize(shuffled)).toEqual(itemize(rows));
      }),
      RUNS,
    );
  });

  it("a fully reversed entry leaves the owed and credit figures as if it never existed", () => {
    fc.assert(
      fc.property(ledgerArb, (rows) => {
        const reversed = new Set(
          rows.filter((r) => r.kind === "reversal").map((r) => r.reversesEntryId),
        );
        const without = rows.filter(
          (r) => !(r.kind === "reversal" || reversed.has(r.id)),
        );
        const full = itemize(rows);
        const clean = itemize(without);
        expect(full.owedSek).toBe(clean.owedSek);
        expect(full.creditSek).toBe(clean.creditSek);
      }),
      RUNS,
    );
  });

  it("planReversal never reverses a reversal or an already reversed entry", () => {
    fc.assert(
      fc.property(ledgerArb, (rows) => {
        for (const target of rows) {
          const reversedBy = rows.filter((r) => r.reversesEntryId === target.id).map((r) => r.id);
          if (target.kind === "reversal" || reversedBy.length > 0) {
            expect(() => planReversal(target, reversedBy)).toThrow(LedgerError);
          } else {
            expect(planReversal(target, reversedBy)).toBe(-target.amountSek);
          }
        }
      }),
      RUNS,
    );
  });
});
