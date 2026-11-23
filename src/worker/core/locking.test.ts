import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { member } from "../../../db/schema";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("real transactions", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });

  afterEach(async () => {
    await t.close();
  });

  it("a transaction holding FOR UPDATE blocks a second FOR UPDATE on the same row", async () => {
    const target = await makeMember(t.db);

    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstHoldsLock!: () => void;
    const firstLocked = new Promise<void>((resolve) => (firstHoldsLock = resolve));

    const first = t.db.transaction(async (tx) => {
      await tx.select().from(member).where(eq(member.id, target.id)).for("update");
      firstHoldsLock();
      await gate;
    });

    await firstLocked;

    let secondAcquired = false;
    const second = t.db.transaction(async (tx) => {
      await tx.select().from(member).where(eq(member.id, target.id)).for("update");
      secondAcquired = true;
    });

    await sleep(300);
    expect(secondAcquired).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondAcquired).toBe(true);
  });

  it("rolls back every write when a transaction throws", async () => {
    const countBefore = await t.countMembers();
    await expect(
      t.db.transaction(async (tx) => {
        await makeMember(tx);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await t.countMembers()).toBe(countBefore);
  });
});
