import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../../../db/schema";
import { member } from "../../../db/schema";
import type { Db } from "../core/db/client";

export type { Db };

/** The real migration files, bundled at build time (workerd has no fs). */
const migrations: Record<string, string> = import.meta.glob<string>(
  "../../../db/migrations/*.sql",
  { query: "?raw", import: "default", eager: true },
);

export function migrationFiles(): string[] {
  return Object.keys(migrations).sort();
}

/** Runs one migration SQL file in order. drizzle-kit separates statements with this marker. */
export function migrationStatements(file: string): string[] {
  const sqlText: string = migrations[file] ?? "";
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export interface TestDatabase {
  readonly db: Db;
  /** Member row count, used by the rollback test. */
  countMembers(): Promise<number>;
  close(): Promise<void>;
}

/** Reads DATABASE_URL in plain Node; the workerd pool has no `process`, so it falls back. */
function readDatabaseUrl(): string {
  const fromEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.DATABASE_URL;
  return fromEnv ?? "postgres://postgres:postgres@localhost:5432/club_test";
}
const BASE_URL: string = readDatabaseUrl();

/**
 * Creates an isolated, freshly migrated database per test. Hyperdrive is the
 * production path (docs/ops/db.md); tests use the same `pg` driver over TCP to
 * a real Postgres so transactions and row locks are real.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `club_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  await admin.end();

  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
  // close() drops the database WITH (force), which terminates any pool connection still
  // shutting down (57P01). That is expected teardown, not a test failure; without a
  // listener pg rethrows it as an unhandled error and Vitest fails the run.
  pool.on("error", () => undefined);
  const db: Db = drizzle(pool, { schema });

  for (const file of migrationFiles()) {
    for (const statement of migrationStatements(file)) {
      await pool.query(statement);
    }
  }

  return {
    db,
    async countMembers() {
      const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${member}`);
      return rows.rows[0]?.n ?? 0;
    },
    async close() {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: BASE_URL });
      await cleanup.connect();
      await cleanup.query(`drop database if exists "${name}" with (force)`);
      await cleanup.end();
    },
  };
}
