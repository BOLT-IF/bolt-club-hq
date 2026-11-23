import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { ledgerEntry } from "../../../db/schema";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeLedgerEntry, makeMember } from "../test-support/factories";

/** drizzle wraps pg errors as "Failed query: ..."; the trigger message sits on `cause`. */
async function expectAppendOnlyViolation(operation: Promise<unknown>): Promise<void> {
  const error = await operation.then(
    () => {
      throw new Error("expected the ledger write to be rejected");
    },
    (caught: unknown) => caught,
  );
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  expect(String(cause)).toMatch(/append-only/);
}

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
    await expectAppendOnlyViolation(
      t.db.update(ledgerEntry).set({ amountSek: 999 }).where(eq(ledgerEntry.id, entry.id)),
    );
  });

  it("rejects DELETE", async () => {
    const member = await makeMember(t.db);
    const entry = await makeLedgerEntry(t.db, member.id, { amountSek: 150 });
    await expectAppendOnlyViolation(t.db.delete(ledgerEntry).where(eq(ledgerEntry.id, entry.id)));
  });

  it("allows exported_at to be stamped exactly once", async () => {
    const member = await makeMember(t.db);
    const entry = await makeLedgerEntry(t.db, member.id, { amountSek: 150 });
    await t.db
      .update(ledgerEntry)
      .set({ exportedAt: new Date("2026-11-23T10:00:00Z") })
      .where(eq(ledgerEntry.id, entry.id));

    await expectAppendOnlyViolation(
      t.db
        .update(ledgerEntry)
        .set({ exportedAt: new Date("2026-11-24T10:00:00Z") })
        .where(eq(ledgerEntry.id, entry.id)),
    );
  });

  it("refuses an exported_at stamp that also changes another column", async () => {
    const member = await makeMember(t.db);
    const entry = await makeLedgerEntry(t.db, member.id, { amountSek: 150 });
    await expectAppendOnlyViolation(
      t.db
        .update(ledgerEntry)
        .set({ exportedAt: new Date("2026-11-23T10:00:00Z"), amountSek: 1 })
        .where(eq(ledgerEntry.id, entry.id)),
    );
  });
});
