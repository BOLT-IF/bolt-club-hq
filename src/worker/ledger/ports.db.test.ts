import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { ledgerEntry } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import type { ChargePort, ReversePort } from "../core/ports";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { createChargePort, createReversePort } from "./ports";
import { ledgerEntryIdFor } from "./service";

describe("ChargePort / ReversePort production adapters", () => {
  let t: TestDatabase;
  let charge: ChargePort;
  let reverse: ReversePort;

  beforeEach(async () => {
    t = await createTestDatabase();
    const deps = { db: t.db, clock: new FixedClock("2027-01-10T10:00:00Z") };
    charge = createChargePort(deps);
    reverse = createReversePort(deps);
  });

  afterEach(async () => {
    await t.close();
  });

  const rowsOf = (memberId: string) =>
    t.db.select().from(ledgerEntry).where(eq(ledgerEntry.memberId, memberId));

  it("charge writes a ledger charge, once per idempotency key", async () => {
    const m = await makeMember(t.db);
    const input = {
      memberId: m.id,
      amountSek: 120,
      reason: "adhoc",
      idempotencyKey: "close:e1:m1",
    };
    await charge.charge(input);
    await charge.charge(input);
    const rows = await rowsOf(m.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: ledgerEntryIdFor("close:e1:m1"),
      kind: "charge",
      amountSek: 120,
      reason: "adhoc",
    });
  });

  it("charge keeps the optional event, pass and guest context", async () => {
    const m = await makeMember(t.db);
    const adapter = createChargePort({ db: t.db, clock: new FixedClock("2027-01-10T10:00:00Z") });
    await adapter.charge({
      memberId: m.id,
      amountSek: 50,
      reason: "manual",
      idempotencyKey: "ctx",
      note: "court hire",
    });
    expect((await rowsOf(m.id))[0]?.note).toBe("court hire");
  });

  it("charge refuses non-integer amounts and unknown reasons", async () => {
    const m = await makeMember(t.db);
    await expect(
      charge.charge({ memberId: m.id, amountSek: 10.5, reason: "adhoc", idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      charge.charge({ memberId: m.id, amountSek: 10, reason: "Event fee", idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ code: "invalid_reason" });
    expect(await rowsOf(m.id)).toHaveLength(0);
  });

  it("reverse cancels a charge once, and refuses a reversal", async () => {
    const m = await makeMember(t.db);
    await charge.charge({ memberId: m.id, amountSek: 120, reason: "guest", idempotencyKey: "c" });
    const entryId = ledgerEntryIdFor("c");
    await reverse.reverse({ entryId, idempotencyKey: "r" });
    await reverse.reverse({ entryId, idempotencyKey: "r" });
    const rows = await rowsOf(m.id);
    expect(rows.reduce((sum, r) => sum + r.amountSek, 0)).toBe(0);
    expect(rows).toHaveLength(2);

    await expect(
      reverse.reverse({ entryId: ledgerEntryIdFor("r"), idempotencyKey: "rr" }),
    ).rejects.toMatchObject({ code: "cannot_reverse_reversal" });
    await expect(reverse.reverse({ entryId, idempotencyKey: "r-other" })).rejects.toMatchObject({
      code: "already_reversed",
    });
  });

  it("the adapters take a transaction: a rollback removes the charge", async () => {
    const m = await makeMember(t.db);
    await expect(
      t.db.transaction(async (tx) => {
        await createChargePort({ db: tx, clock: new FixedClock("2027-01-10T10:00:00Z") }).charge({
          memberId: m.id,
          amountSek: 120,
          reason: "adhoc",
          idempotencyKey: "tx",
        });
        throw new Error("close failed");
      }),
    ).rejects.toThrow("close failed");
    expect(await rowsOf(m.id)).toHaveLength(0);
  });
});
