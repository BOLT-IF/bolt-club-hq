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

describe("migrations", () => {
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

  it("ships one contiguous chain that starts with the initial migration", () => {
    const files = migrationFiles().map((f) => f.replace("../../../db/migrations/", ""));
    expect(files[0]).toBe("0000_initial.sql");
    files.forEach((f, i) => {
      expect(f.slice(0, 5)).toBe(`${String(i).padStart(4, "0")}_`);
    });
  });

  it("0001_polls stores one vote row per chosen option (multi-choice)", async () => {
    const rows = await t.db.execute<{ column_name: string }>(sql`
      select a.attname as column_name
      from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'poll_vote'::regclass and i.indisprimary
    `);
    expect(rows.rows.map((r) => r.column_name).sort()).toEqual([
      "member_id",
      "option_id",
      "poll_id",
    ]);
  });
});
