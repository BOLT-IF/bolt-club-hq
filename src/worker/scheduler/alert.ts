import { and, eq } from "drizzle-orm";

import { member } from "../../../db/schema";
import type { Db } from "../core/db/client";
import { createNotifyPort } from "../notifications/notify";

/**
 * Raises the `admin_tasks` alert for a stale tick: one notification per active admin,
 * through the S6.1 notify port (inbox row, policy chain, queued push). The idempotency
 * key holds the last good tick, so one outage alerts once, however many ticks notice it.
 */
export async function alertStaleTick(
  db: Db,
  info: { lastTickAt: number; now: Date },
): Promise<void> {
  const admins = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.role, "admin"), eq(member.status, "active")));
  const port = createNotifyPort({ db, clock: { now: () => info.now } });
  const since = new Date(info.lastTickAt).toISOString();
  for (const admin of admins) {
    await port.notify({
      memberId: admin.id,
      category: "admin_tasks",
      title: "Scheduled tasks have stopped",
      body: `The club scheduler has not run since ${since}. Reminders and event closing may be delayed.`,
      idempotencyKey: `scheduler-stale:${String(info.lastTickAt)}:${admin.id}`,
    });
  }
}
