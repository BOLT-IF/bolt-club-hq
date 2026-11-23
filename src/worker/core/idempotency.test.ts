import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { ledgerEntry } from "../../../../db/schema";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { idempotencyKeyMiddleware } from "./idempotency";
import { insertIdempotent } from "./db/idempotent-insert";

describe("DB idempotency helper", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });

  afterEach(async () => {
    await t.close();
  });

  it("10 concurrent idempotent inserts with one key produce exactly 1 row", async () => {
    const member = await makeMember(t.db);
    const values = {
      memberId: member.id,
      kind: "charge" as const,
      amountSek: 150,
      reason: "pass" as const,
      note: "pass purchase",
      createdBy: member.id,
      idempotencyKey: "pass-purchase-42",
    };

    await Promise.all(Array.from({ length: 10 }, () => insertIdempotent(t.db, values)));

    const rows = await t.db
      .select()
      .from(ledgerEntry)
      .where(eq(ledgerEntry.idempotencyKey, "pass-purchase-42"));
    expect(rows).toHaveLength(1);
  });
});

describe("HTTP Idempotency-Key middleware", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });

  afterEach(async () => {
    await t.close();
  });

  it("replays the stored response for a repeated key without running the handler again", async () => {
    let handlerCalls = 0;
    const app = new Hono();
    app.post(
      "/api/v1/ledger",
      idempotencyKeyMiddleware({ db: t.db, route: "POST /api/v1/ledger", actorOf: () => "actor-1" }),
      (c) => {
        handlerCalls += 1;
        return c.json({ created: handlerCalls }, 201);
      },
    );

    const send = () =>
      app.request("/api/v1/ledger", {
        method: "POST",
        headers: { "Idempotency-Key": "key-abc" },
      });

    const first = await send();
    const second = await send();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ created: 1 });
    expect(handlerCalls).toBe(1);
  });

  it("rejects a money POST without an Idempotency-Key header", async () => {
    const app = new Hono();
    app.post(
      "/api/v1/ledger",
      idempotencyKeyMiddleware({ db: t.db, route: "POST /api/v1/ledger", actorOf: () => "actor-1" }),
      (c) => c.json({ ok: true }, 201),
    );
    const res = await app.request("/api/v1/ledger", { method: "POST" });
    expect(res.status).toBe(400);
  });
});
