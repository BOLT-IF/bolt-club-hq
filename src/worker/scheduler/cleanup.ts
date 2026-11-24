import { and, isNull, lt } from "drizzle-orm";

import { idempotencyRecord } from "../../../db/schema";
import type { Clock } from "../core/clock";
import type { Db } from "../core/db/client";

/** A claim with no stored response older than this belongs to a Worker that died mid-request. */
export const STALE_CLAIM_MS = 10 * 60_000;

/**
 * Removes empty idempotency claims left by a killed Worker (DECISIONS 2026-11-23,
 * "idempotency is claim-first"). Claims with a stored response are the replay cache
 * and stay. Returns the number removed.
 */
export async function deleteStaleClaims(db: Db, clock: Clock): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - STALE_CLAIM_MS);
  const removed = await db
    .delete(idempotencyRecord)
    .where(and(isNull(idempotencyRecord.responseBody), lt(idempotencyRecord.createdAt, cutoff)))
    .returning({ key: idempotencyRecord.key });
  return removed.length;
}
