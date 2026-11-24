import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { auditLog, ledgerEntry } from "../../../db/schema";
import { LedgerError } from "../../domain/ledger";
import { FixedClock } from "../core/clock";
import type { CurrentMember } from "../core/ports";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { createLedgerService, ledgerEntryIdFor, type LedgerService } from "./service";

function actorOf(m: { id: string; role: "member" | "admin" }): CurrentMember {
  return { id: m.id, role: m.role, status: "active", seriesIds: [] };
}

async function codeOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  return "no error";
}

describe("ledger service", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let ledger: LedgerService;

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock("2027-01-10T10:00:00Z");
    ledger = createLedgerService({ db: t.db, clock });
  });

  afterEach(async () => {
    await t.close();
  });

  const rowsOf = (memberId: string) =>
    t.db.select().from(ledgerEntry).where(eq(ledgerEntry.memberId, memberId));

  describe("charge", () => {
    it("writes a positive entry stamped with the injected clock", async () => {
      const m = await makeMember(t.db);
      const result = await ledger.charge({
        memberId: m.id,
        amountSek: 120,
        reason: "adhoc",
        idempotencyKey: "k-charge-1",
      });
      expect(result).toEqual({ entryId: ledgerEntryIdFor("k-charge-1"), created: true });
      const [row] = await rowsOf(m.id);
      expect(row).toMatchObject({
        kind: "charge",
        amountSek: 120,
        reason: "adhoc",
        createdBy: m.id,
        idempotencyKey: "k-charge-1",
      });
      expect(row?.createdAt.toISOString()).toBe("2027-01-10T10:00:00.000Z");
      expect(await ledger.balance(m.id)).toBe(120);
    });

    it("a repeated idempotency key writes nothing and returns the same entry", async () => {
      const m = await makeMember(t.db);
      const input = { memberId: m.id, amountSek: 120, reason: "adhoc", idempotencyKey: "k-dup" };
      const first = await ledger.charge({ ...input, reason: "adhoc" });
      const second = await ledger.charge({ ...input, reason: "adhoc" });
      expect(second).toEqual({ entryId: first.entryId, created: false });
      expect(await rowsOf(m.id)).toHaveLength(1);
    });

    it("concurrent copies of one key settle on one row", async () => {
      const m = await makeMember(t.db);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          ledger.charge({ memberId: m.id, amountSek: 90, reason: "guest", idempotencyKey: "k-race" }),
        ),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.entryId)).size).toBe(1);
      expect(await rowsOf(m.id)).toHaveLength(1);
    });

    it("reusing a key for a different charge is a conflict, not a silent no-op", async () => {
      const m = await makeMember(t.db);
      const other = await makeMember(t.db);
      await ledger.charge({ memberId: m.id, amountSek: 120, reason: "adhoc", idempotencyKey: "k-x" });
      expect(
        await codeOf(
          ledger.charge({ memberId: m.id, amountSek: 130, reason: "adhoc", idempotencyKey: "k-x" }),
        ),
      ).toBe("idempotency_conflict");
      expect(
        await codeOf(
          ledger.charge({ memberId: other.id, amountSek: 120, reason: "adhoc", idempotencyKey: "k-x" }),
        ),
      ).toBe("idempotency_conflict");
      expect(await rowsOf(m.id)).toHaveLength(1);
      expect(await rowsOf(other.id)).toHaveLength(0);
    });

    it("refuses non-integer, zero and negative amounts and writes nothing", async () => {
      const m = await makeMember(t.db);
      for (const [index, amountSek] of [1.5, 0, -10, Number.NaN, 2 ** 31].entries()) {
        expect(
          await codeOf(
            ledger.charge({
              memberId: m.id,
              amountSek,
              reason: "adhoc",
              idempotencyKey: `k-bad-${String(index)}`,
            }),
          ),
        ).toBe("invalid_amount");
      }
      expect(await rowsOf(m.id)).toHaveLength(0);
    });

    it("only pass, adhoc, guest and manual are charge reasons", async () => {
      const m = await makeMember(t.db);
      for (const reason of ["payment", "waiver", "revocation", "opening_balance", "nonsense"]) {
        expect(
          await codeOf(
            ledger.charge({ memberId: m.id, amountSek: 10, reason, idempotencyKey: `k-${reason}` }),
          ),
        ).toBe("invalid_reason");
      }
      expect(await rowsOf(m.id)).toHaveLength(0);
    });

    it("refuses an unknown member", async () => {
      expect(
        await codeOf(
          ledger.charge({ memberId: "nobody", amountSek: 10, reason: "adhoc", idempotencyKey: "k-nm" }),
        ),
      ).toBe("member_not_found");
    });
  });

  describe("recordPayment", () => {
    it("is stored negative, only an admin can record it, and it lowers the balance", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const plain = await makeMember(t.db);
      await ledger.charge({ memberId: plain.id, amountSek: 300, reason: "pass", idempotencyKey: "c1" });

      const paid = await ledger.recordPayment({
        memberId: plain.id,
        amountSek: 100,
        actor: actorOf(admin),
        idempotencyKey: "p1",
      });
      expect(paid.created).toBe(true);
      const row = (await rowsOf(plain.id)).find((r) => r.kind === "payment");
      expect(row).toMatchObject({ amountSek: -100, reason: "payment", createdBy: admin.id });
      expect(await ledger.balance(plain.id)).toBe(200);

      expect(
        await codeOf(
          ledger.recordPayment({
            memberId: plain.id,
            amountSek: 100,
            actor: actorOf(plain),
            idempotencyKey: "p2",
          }),
        ),
      ).toBe("forbidden");
      expect(await ledger.balance(plain.id)).toBe(200);
    });

    it("a double-tapped payment is recorded once", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const plain = await makeMember(t.db);
      const input = {
        memberId: plain.id,
        amountSek: 100,
        actor: actorOf(admin),
        idempotencyKey: "p-double",
      };
      await Promise.all([ledger.recordPayment(input), ledger.recordPayment(input)]);
      expect(await ledger.balance(plain.id)).toBe(-100);
      expect(await rowsOf(plain.id)).toHaveLength(1);
    });

    it("records the claim it came from", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const plain = await makeMember(t.db);
      await ledger.recordPayment({
        memberId: plain.id,
        amountSek: 50,
        actor: actorOf(admin),
        idempotencyKey: "p-claim",
        paymentClaimId: "claim-1",
      });
      expect((await rowsOf(plain.id))[0]?.paymentClaimId).toBe("claim-1");
    });

    it("rejects a non-integer amount", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const plain = await makeMember(t.db);
      expect(
        await codeOf(
          ledger.recordPayment({
            memberId: plain.id,
            amountSek: 99.5,
            actor: actorOf(admin),
            idempotencyKey: "p-frac",
          }),
        ),
      ).toBe("invalid_amount");
    });
  });

  describe("self-ledger guard (PLAN A11)", () => {
    it("blocks an admin recording a payment or adjustment on their own ledger when another admin exists", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      await makeMember(t.db, { role: "admin" });
      await ledger.charge({ memberId: admin.id, amountSek: 200, reason: "pass", idempotencyKey: "c" });

      expect(
        await codeOf(
          ledger.recordPayment({
            memberId: admin.id,
            amountSek: 200,
            actor: actorOf(admin),
            idempotencyKey: "self-pay",
          }),
        ),
      ).toBe("self_ledger_blocked");
      expect(
        await codeOf(
          ledger.adjust({
            memberId: admin.id,
            amountSek: -200,
            reason: "waiver",
            note: "waive my own debt",
            actor: actorOf(admin),
            idempotencyKey: "self-waive",
          }),
        ),
      ).toBe("self_ledger_blocked");
      expect(await ledger.balance(admin.id)).toBe(200);
      expect(await rowsOf(admin.id)).toHaveLength(1);
    });

    it("blocks an admin reversing a charge on their own ledger when another admin exists", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      await makeMember(t.db, { role: "admin" });
      const charged = await ledger.charge({
        memberId: admin.id,
        amountSek: 200,
        reason: "pass",
        idempotencyKey: "c",
      });
      expect(
        await codeOf(
          ledger.reverse({
            entryId: charged.entryId,
            actor: actorOf(admin),
            note: "revoke my own pass",
            idempotencyKey: "self-rev",
          }),
        ),
      ).toBe("self_ledger_blocked");
      expect(await ledger.balance(admin.id)).toBe(200);
    });

    it("an inactive admin does not count as another admin", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      await makeMember(t.db, { role: "admin", status: "inactive" });
      const result = await ledger.recordPayment({
        memberId: admin.id,
        amountSek: 10,
        actor: actorOf(admin),
        idempotencyKey: "solo",
      });
      expect(result.created).toBe(true);
    });

    it("lets the only admin through, and flags it in the audit log", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const result = await ledger.recordPayment({
        memberId: admin.id,
        amountSek: 75,
        actor: actorOf(admin),
        idempotencyKey: "solo-pay",
      });
      expect(result.created).toBe(true);
      expect(await ledger.balance(admin.id)).toBe(-75);

      const [audit] = await t.db.select().from(auditLog).where(eq(auditLog.entityId, result.entryId));
      expect(audit?.action).toBe("ledger.payment");
      expect(audit?.actorId).toBe(admin.id);
      expect(JSON.parse(audit?.after ?? "{}")).toMatchObject({
        memberId: admin.id,
        amountSek: -75,
        selfLedgerFlagged: true,
      });
    });

    it("an admin acting on someone else's ledger is audited without the flag", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const plain = await makeMember(t.db);
      const result = await ledger.recordPayment({
        memberId: plain.id,
        amountSek: 40,
        actor: actorOf(admin),
        idempotencyKey: "other-pay",
      });
      const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, result.entryId));
      expect(audits).toHaveLength(1);
      expect(JSON.parse(audits[0]?.after ?? "{}")).toMatchObject({ selfLedgerFlagged: false });
    });

    it("a replayed admin write does not audit twice", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const plain = await makeMember(t.db);
      const input = { memberId: plain.id, amountSek: 40, actor: actorOf(admin), idempotencyKey: "r" };
      const first = await ledger.recordPayment(input);
      await ledger.recordPayment(input);
      expect(await t.db.select().from(auditLog).where(eq(auditLog.entityId, first.entryId))).toHaveLength(1);
    });

    it("system writes (no actor) are never subject to the guard and write no audit row", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      await makeMember(t.db, { role: "admin" });
      const result = await ledger.charge({
        memberId: admin.id,
        amountSek: 120,
        reason: "adhoc",
        idempotencyKey: "sys",
      });
      expect(result.created).toBe(true);
      expect(await t.db.select().from(auditLog)).toHaveLength(0);
    });
  });

  describe("adjust", () => {
    it("a waiver is negative and needs a reason note", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const plain = await makeMember(t.db);
      await ledger.charge({ memberId: plain.id, amountSek: 100, reason: "adhoc", idempotencyKey: "c" });

      const base = { memberId: plain.id, actor: actorOf(admin), reason: "waiver" as const };
      expect(
        await codeOf(ledger.adjust({ ...base, amountSek: 30, note: "x", idempotencyKey: "w-pos" })),
      ).toBe("invalid_reason");
      expect(
        await codeOf(ledger.adjust({ ...base, amountSek: -30, note: "  ", idempotencyKey: "w-note" })),
      ).toBe("note_required");
      const ok = await ledger.adjust({
        ...base,
        amountSek: -30,
        note: "injury, agreed with treasurer",
        idempotencyKey: "w-ok",
      });
      expect(ok.created).toBe(true);
      expect(await ledger.balance(plain.id)).toBe(70);
      const row = (await rowsOf(plain.id)).find((r) => r.id === ok.entryId);
      expect(row).toMatchObject({
        kind: "adjustment",
        reason: "waiver",
        amountSek: -30,
        note: "injury, agreed with treasurer",
      });
    });

    it("manual and opening-balance adjustments may go either way; whole kronor only", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const plain = await makeMember(t.db);
      const base = { memberId: plain.id, actor: actorOf(admin), note: "imported" };
      await ledger.adjust({ ...base, amountSek: 500, reason: "opening_balance", idempotencyKey: "o" });
      await ledger.adjust({ ...base, amountSek: -50, reason: "manual", idempotencyKey: "m" });
      expect(await ledger.balance(plain.id)).toBe(450);
      expect(
        await codeOf(ledger.adjust({ ...base, amountSek: 1.25, reason: "manual", idempotencyKey: "f" })),
      ).toBe("invalid_amount");
      expect(
        await codeOf(ledger.adjust({ ...base, amountSek: 0, reason: "manual", idempotencyKey: "z" })),
      ).toBe("invalid_amount");
    });

    it("refuses an adjustment reason that has its own entry kind", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const plain = await makeMember(t.db);
      expect(
        await codeOf(
          ledger.adjust({
            memberId: plain.id,
            amountSek: -10,
            reason: "payment",
            note: "n",
            actor: actorOf(admin),
            idempotencyKey: "bad-reason",
          }),
        ),
      ).toBe("invalid_reason");
    });
  });

  describe("reverse", () => {
    it("writes the negated amount, linked to the original, with its context copied", async () => {
      const m = await makeMember(t.db);
      const charged = await ledger.charge({
        memberId: m.id,
        amountSek: 150,
        reason: "adhoc",
        idempotencyKey: "c",
      });
      clock.advance(1000);
      const reversed = await ledger.reverse({ entryId: charged.entryId, idempotencyKey: "r" });
      expect(reversed.created).toBe(true);
      const row = (await rowsOf(m.id)).find((r) => r.id === reversed.entryId);
      expect(row).toMatchObject({
        kind: "reversal",
        amountSek: -150,
        reason: "adhoc",
        reversesEntryId: charged.entryId,
        memberId: m.id,
      });
      expect(await ledger.balance(m.id)).toBe(0);
    });

    it("reversing a reversal is refused", async () => {
      const m = await makeMember(t.db);
      const charged = await ledger.charge({
        memberId: m.id,
        amountSek: 150,
        reason: "adhoc",
        idempotencyKey: "c",
      });
      const reversed = await ledger.reverse({ entryId: charged.entryId, idempotencyKey: "r" });
      expect(await codeOf(ledger.reverse({ entryId: reversed.entryId, idempotencyKey: "rr" }))).toBe(
        "cannot_reverse_reversal",
      );
      expect(await rowsOf(m.id)).toHaveLength(2);
      expect(await ledger.balance(m.id)).toBe(0);
    });

    it("an entry is reversed at most once, under a different key", async () => {
      const m = await makeMember(t.db);
      const charged = await ledger.charge({
        memberId: m.id,
        amountSek: 150,
        reason: "adhoc",
        idempotencyKey: "c",
      });
      await ledger.reverse({ entryId: charged.entryId, idempotencyKey: "r1" });
      expect(await codeOf(ledger.reverse({ entryId: charged.entryId, idempotencyKey: "r2" }))).toBe(
        "already_reversed",
      );
      expect(await ledger.balance(m.id)).toBe(0);
    });

    it("the same key replays the original reversal instead of failing", async () => {
      const m = await makeMember(t.db);
      const charged = await ledger.charge({
        memberId: m.id,
        amountSek: 150,
        reason: "adhoc",
        idempotencyKey: "c",
      });
      const first = await ledger.reverse({ entryId: charged.entryId, idempotencyKey: "r1" });
      const again = await ledger.reverse({ entryId: charged.entryId, idempotencyKey: "r1" });
      expect(again).toEqual({ entryId: first.entryId, created: false });
      expect(await rowsOf(m.id)).toHaveLength(2);
    });

    it("concurrent reversals of one entry under different keys produce exactly one reversal", async () => {
      const m = await makeMember(t.db);
      const charged = await ledger.charge({
        memberId: m.id,
        amountSek: 150,
        reason: "adhoc",
        idempotencyKey: "c",
      });
      const outcomes = await Promise.allSettled(
        ["ra", "rb", "rc", "rd"].map((key) =>
          ledger.reverse({ entryId: charged.entryId, idempotencyKey: key }),
        ),
      );
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          expect((outcome.reason as LedgerError).code).toBe("already_reversed");
        }
      }
      expect((await rowsOf(m.id)).filter((r) => r.kind === "reversal")).toHaveLength(1);
      expect(await ledger.balance(m.id)).toBe(0);
    });

    it("refuses an unknown entry", async () => {
      expect(await codeOf(ledger.reverse({ entryId: "led_nope", idempotencyKey: "r" }))).toBe(
        "entry_not_found",
      );
    });

    it("a reversed payment puts the debt back", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      await ledger.charge({ memberId: m.id, amountSek: 100, reason: "adhoc", idempotencyKey: "c" });
      const paid = await ledger.recordPayment({
        memberId: m.id,
        amountSek: 100,
        actor: actorOf(admin),
        idempotencyKey: "p",
      });
      await ledger.reverse({
        entryId: paid.entryId,
        actor: actorOf(admin),
        note: "bounced",
        idempotencyKey: "rp",
      });
      expect(await ledger.balance(m.id)).toBe(100);
    });

    it("a waiver reversal needs a note, and an override reason is stored", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      const charged = await ledger.charge({
        memberId: m.id,
        amountSek: 100,
        reason: "pass",
        idempotencyKey: "c",
      });
      expect(
        await codeOf(
          ledger.reverse({
            entryId: charged.entryId,
            reason: "waiver",
            actor: actorOf(admin),
            idempotencyKey: "w0",
          }),
        ),
      ).toBe("note_required");
      const done = await ledger.reverse({
        entryId: charged.entryId,
        reason: "waiver",
        note: "club decision",
        actor: actorOf(admin),
        idempotencyKey: "w1",
      });
      const row = (await rowsOf(m.id)).find((r) => r.id === done.entryId);
      expect(row).toMatchObject({ reason: "waiver", note: "club decision", amountSek: -100 });
      const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, done.entryId));
      expect(audits.map((a) => a.action)).toEqual(["ledger.reverse"]);
    });
  });

  describe("balance and itemize", () => {
    it("balance equals the sum of the member's entries and ignores other members", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const a = await makeMember(t.db);
      const b = await makeMember(t.db);
      await ledger.charge({ memberId: a.id, amountSek: 120, reason: "adhoc", idempotencyKey: "a1" });
      await ledger.charge({ memberId: a.id, amountSek: 80, reason: "guest", idempotencyKey: "a2" });
      await ledger.recordPayment({
        memberId: a.id,
        amountSek: 50,
        actor: actorOf(admin),
        idempotencyKey: "a3",
      });
      await ledger.charge({ memberId: b.id, amountSek: 999, reason: "pass", idempotencyKey: "b1" });
      const sum = (await rowsOf(a.id)).reduce((acc, r) => acc + r.amountSek, 0);
      expect(await ledger.balance(a.id)).toBe(sum);
      expect(sum).toBe(150);
      expect(await ledger.balance(b.id)).toBe(999);
      expect(await ledger.balance("nobody")).toBe(0);
    });

    it("itemize allocates FIFO from the database rows: a partial payment splits, credit carries", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      const c1 = await ledger.charge({ memberId: m.id, amountSek: 100, reason: "adhoc", idempotencyKey: "c1" });
      clock.advance(1000);
      const c2 = await ledger.charge({ memberId: m.id, amountSek: 200, reason: "adhoc", idempotencyKey: "c2" });
      clock.advance(1000);
      await ledger.recordPayment({
        memberId: m.id,
        amountSek: 150,
        actor: actorOf(admin),
        idempotencyKey: "p1",
      });

      const partial = await ledger.itemize(m.id);
      expect(partial).toMatchObject({ balanceSek: 150, owedSek: 150, creditSek: 0 });
      const status = (id: string) => partial.items.find((i) => i.entry.id === id)?.status;
      expect(status(c1.entryId)).toBe("paid");
      expect(status(c2.entryId)).toBe("partly_paid");

      clock.advance(1000);
      await ledger.recordPayment({
        memberId: m.id,
        amountSek: 250,
        actor: actorOf(admin),
        idempotencyKey: "p2",
      });
      expect(await ledger.itemize(m.id)).toMatchObject({ balanceSek: -100, owedSek: 0, creditSek: 100 });

      clock.advance(1000);
      await ledger.charge({ memberId: m.id, amountSek: 60, reason: "adhoc", idempotencyKey: "c3" });
      expect(await ledger.itemize(m.id)).toMatchObject({ balanceSek: -40, owedSek: 0, creditSek: 40 });
    });
  });
});
