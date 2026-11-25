import { and, eq, isNotNull, lt } from "drizzle-orm";

import { notificationSendLog, poll, pollOption } from "../../../db/schema";
import { registerTickHook, type TickContext } from "../scheduler/registry";

export const PRIVACY_RETENTION_HOOK = "privacy-retention-purge";
/** PLAN §16: notification send log retention is 1 year. */
export const SEND_LOG_RETENTION_DAYS = 365;
/** PLAN §16: poll images are deleted 6 months after poll close. */
export const POLL_IMAGE_RETENTION_DAYS = 180;

const DAY_MS = 86_400_000;

export interface MediaDeletePort {
  delete(keys: string | string[]): Promise<void>;
}

async function workerEnv(): Promise<{ MEDIA?: R2Bucket } | null> {
  try {
    const { env } = await import("cloudflare:workers");
    return env;
  } catch {
    return null;
  }
}

/**
 * Deletes records past their PLAN §16 retention windows using the injected clock:
 * - `notification_send_log` older than 365 days
 * - `poll_option.image_key` (and R2 `MEDIA` objects) for polls closed more than 180 days ago
 */
export async function runRetentionPurge(
  ctx: Pick<TickContext, "db" | "clock" | "now">,
  deps?: { media?: MediaDeletePort },
): Promise<{ sendLogsDeleted: number; pollImagesDeleted: number }> {
  const nowMs = ctx.now.getTime();
  const sendCutoff = new Date(nowMs - SEND_LOG_RETENTION_DAYS * DAY_MS);
  const pollCutoff = new Date(nowMs - POLL_IMAGE_RETENTION_DAYS * DAY_MS);

  const deletedLogs = await ctx.db
    .delete(notificationSendLog)
    .where(lt(notificationSendLog.sentAt, sendCutoff))
    .returning({ id: notificationSendLog.id });

  const expiredImages = await ctx.db
    .select({
      optionId: pollOption.id,
      imageKey: pollOption.imageKey,
    })
    .from(pollOption)
    .innerJoin(poll, eq(pollOption.pollId, poll.id))
    .where(
      and(isNotNull(pollOption.imageKey), isNotNull(poll.closesAt), lt(poll.closesAt, pollCutoff)),
    );

  let pollImagesDeleted = 0;
  if (expiredImages.length > 0) {
    const media = deps?.media ?? (await workerEnv())?.MEDIA;
    if (media) {
      for (const row of expiredImages) {
        if (!row.imageKey) continue;
        await media.delete(row.imageKey);
        await ctx.db
          .update(pollOption)
          .set({ imageKey: null })
          .where(eq(pollOption.id, row.optionId));
        pollImagesDeleted += 1;
      }
    }
  }

  return {
    sendLogsDeleted: deletedLogs.length,
    pollImagesDeleted,
  };
}

// Registered at module load (imported by `privacy/routes.ts`) so the scheduler's daily
// maintenance pass runs retention cleanup automatically.
registerTickHook(PRIVACY_RETENTION_HOOK, async (ctx) => {
  await runRetentionPurge(ctx);
});
