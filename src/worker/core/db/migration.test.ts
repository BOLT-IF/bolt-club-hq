import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createTestDatabase, migrationFiles, type TestDatabase } from "../../test-support/database";

/** Every table named in docs/PLAN.md §5.1. */
const PLAN_TABLES = [
  "member",
  "invite",
  "join_request",
  "club_settings",
  "term",
  "series",
  "series_captain",
  "event",
  "pass",
  "rsvp",
  "guest",
  "ledger_entry",
  "payment_claim",
  "idempotency_record",
  "notification",
  "push_subscription",
  "notification_pref",
  "reminder_rule",
  "notification_send_log",
  "outbound_push",
  "scheduler_state",
  "poll",
  "poll_option",
  "poll_vote",
  "audit_log",
  "domain_event_outbox",
];

describe("initial migration", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });

  afterEach(async () => {
    await t.close();
  });

  it("applies cleanly to an empty Postgres schema and creates every PLAN §5.1 table", async () => {
    const rows = await t.db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = current_schema() and table_type = 'BASE TABLE'
    `);
    const names = rows.rows.map((row) => row.table_name);
    for (const table of PLAN_TABLES) {
      expect(names, `missing table ${table}`).toContain(table);
    }
  });

  it("ships exactly one initial migration file", () => {
    expect(migrationFiles()).toEqual(["../../../db/migrations/0000_initial.sql"]);
  });
});
