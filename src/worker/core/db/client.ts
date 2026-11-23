import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../../../../db/schema";

/**
 * Database client. Production connects through Hyperdrive (`env.HYPERDRIVE.connectionString`);
 * tests connect to the local Postgres from DATABASE_URL. Both use the `pg` driver
 * over TCP, so transactions and row locks are real (docs/ops/db.md).
 */
export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 5 });
  return drizzle(pool, { schema });
}

/** Runs `fn` in one transaction. Throwing inside `fn` rolls every write back. */
export async function transact<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
