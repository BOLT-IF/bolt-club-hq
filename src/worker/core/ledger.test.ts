import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { ledgerEntry } from "../../../../db/schema";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeLedgerEntry, makeMember } from "../test-support/factories";

describe("ledger append-only guard", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });

  afterEach(async () => {
    await t.close();
  });

  it("rejects UPDATE of an amount", async () => {
    const member = await makeMember(t.db);
    const entry = await makeLedgerEntry(t.db, member.id, { amountSek: 150 });
    await expect(
      t.db.update(ledgerEntry).set({ amountSek: 999 }).where(eq(ledgerEntry.id, entry.id)),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects DELETE", async () => {
    const member = await makeMember(t.db);
    const entry = await makeLedgerEntry(t.db, member.id, { amountSek: 150 });
    await expect(t.db.delete(ledgerEntry).where(eq(ledgerEntry.id, entry.id))).rejects.toThrow(
      /append-only/,
    );
  });

  it("allows exported_at to be stamped exactly once", async () => {
    const member = await makeMember(t.db);
    const entry = await makeLedgerEntry(t.db, member.id, { amountSek: 150 });
    await t.db
      .update(ledgerEntry)
      .set({ exportedAt: new Date("2026-11-23T10:00:00Z") })
      .where(eq(ledgerEntry.id, entry.id));

    await expect(
      t.db
        .update(ledgerEntry)
        .set({ exportedAt: new Date("2026-11-24T10:00:00Z") })
        .where(eq(ledgerEntry.id, entry.id)),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses an exported_at stamp that also changes another column", async () => {
    const member = await makeMember(t.db);
    const entry = await makeLedgerEntry(t.db, member.id, { amountSek: 150 });
    await expect(
      t.db
        .update(ledgerEntry)
        .set({ exportedAt: new Date("2026-11-23T10:00:00Z"), amountSek: 1 })
        .where(eq(ledgerEntry.id, entry.id)),
    ).rejects.toThrow(/append-only/);
  });
});
