import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";

import { poll, pollOption } from "../../../db/schema";
import type { Db } from "../core/db/client";
import { registerTickHook, type TickContext } from "../scheduler/registry";
import { deleteMediaKeys } from "./validate";

/** PLAN §10: poll images are purged 6 months after the poll closes. */
export const MEDIA_RETENTION_MONTHS = 6;
const COARSE_CUTOFF_DAYS_MS = 175 * 24 * 60 * 60 * 1000;

/** Computes the exact UTC instant 6 calendar months after `date`, clamping month-end days. */
export function sixMonthsAfter(date: Date): Date {
  const monthSum = date.getUTCMonth() + MEDIA_RETENTION_MONTHS;
  const targetYear = date.getUTCFullYear() + Math.floor(monthSum / 12);
  const targetMonth = monthSum % 12;
  const maxDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), maxDay);
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** True once the poll has closed and 6 calendar months have elapsed since `closesAt`. */
export function isMediaExpired(closesAt: Date | null, now: Date): boolean {
  return closesAt !== null && now.getTime() >= sixMonthsAfter(closesAt).getTime();
}

export interface ExpiredMediaCandidate {
  readonly optionId: string;
  readonly closesAt: Date;
  readonly imageKey: string;
}

export interface MediaPurgeStore {
  findExpiredOptions(coarseCutoff: Date): Promise<ExpiredMediaCandidate[]>;
  clearImageKeys(optionIds: string[]): Promise<void>;
}

export function drizzleMediaStore(db: Db): MediaPurgeStore {
  return {
    async findExpiredOptions(coarseCutoff) {
      const rows = await db
        .select({
          optionId: pollOption.id,
          closesAt: poll.closesAt,
          imageKey: pollOption.imageKey,
        })
        .from(pollOption)
        .innerJoin(poll, eq(poll.id, pollOption.pollId))
        .where(
          and(
            isNotNull(pollOption.imageKey),
            isNotNull(poll.closesAt),
            lte(poll.closesAt, coarseCutoff),
          ),
        );
      return rows.flatMap((row) =>
        row.closesAt !== null && row.imageKey !== null
          ? [{ optionId: row.optionId, closesAt: row.closesAt, imageKey: row.imageKey }]
          : [],
      );
    },
    async clearImageKeys(optionIds) {
      if (optionIds.length === 0) return;
      await db.update(pollOption).set({ imageKey: null }).where(inArray(pollOption.id, optionIds));
    },
  };
}

/** Deletes expired poll images from R2 and clears their `poll_option.image_key` references. */
export async function purgeExpiredMedia(
  store: MediaPurgeStore,
  bucket: Pick<R2Bucket, "delete">,
  now: Date,
): Promise<{ deletedKeys: string[] }> {
  const coarseCutoff = new Date(now.getTime() - COARSE_CUTOFF_DAYS_MS);
  const candidates = await store.findExpiredOptions(coarseCutoff);
  const expired = candidates.filter((c) => isMediaExpired(c.closesAt, now));
  if (expired.length === 0) return { deletedKeys: [] };

  const deletedKeys = [...new Set(expired.map((e) => e.imageKey))];
  await deleteMediaKeys(bucket, deletedKeys);
  await store.clearImageKeys(expired.map((e) => e.optionId));
  return { deletedKeys };
}

async function workerMediaBucket(): Promise<R2Bucket | null> {
  try {
    const { env } = await import("cloudflare:workers");
    return env.MEDIA;
  } catch {
    return null;
  }
}

export async function runMediaPurge(
  ctx: Pick<TickContext, "db" | "now">,
  bucket?: Pick<R2Bucket, "delete"> | null,
): Promise<void> {
  const resolved = bucket === undefined ? await workerMediaBucket() : bucket;
  if (!resolved) return;
  await purgeExpiredMedia(drizzleMediaStore(ctx.db), resolved, ctx.now);
}

registerTickHook("media-purge", async ({ db, now }) => {
  await runMediaPurge({ db, now });
});
