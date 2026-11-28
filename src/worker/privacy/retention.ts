import { lt } from "drizzle-orm";

import { notificationSendLog } from "../../../db/schema";
import { registerTickHook, type TickContext } from "../scheduler/registry";

export const PRIVACY_RETENTION_HOOK = "privacy-retention-purge";
/** PLAN §16: notification send log retention is 1 year. */
export const SEND_LOG_RETENTION_DAYS = 365;

const DAY_MS = 86_400_000;

/**
 * Deletes `notification_send_log` records older than 365 days (PLAN §16) using the injected clock.
 * Poll image retention (6 calendar months) is owned by `src/worker/media/purge.ts`.
 */
export async function runRetentionPurge(
  ctx: Pick<TickContext, "db" | "clock" | "now">,
): Promise<{ sendLogsDeleted: number }> {
  const sendCutoff = new Date(ctx.now.getTime() - SEND_LOG_RETENTION_DAYS * DAY_MS);

  const deletedLogs = await ctx.db
    .delete(notificationSendLog)
    .where(lt(notificationSendLog.sentAt, sendCutoff))
    .returning({ id: notificationSendLog.id });

  return {
    sendLogsDeleted: deletedLogs.length,
  };
}

// Registered at module load (imported by `privacy/routes.ts`) so the scheduler's daily
// maintenance pass runs retention cleanup automatically.
registerTickHook(PRIVACY_RETENTION_HOOK, async (ctx) => {
  await runRetentionPurge(ctx);
});
