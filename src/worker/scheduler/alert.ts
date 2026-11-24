import { and, eq } from "drizzle-orm";

import { member, notification } from "../../../db/schema";
import type { Db } from "../core/db/client";

/**
 * Raises the `admin_tasks` alert for a stale tick: one inbox notification per active
 * admin. The idempotency key holds the last good tick, so one outage alerts once, no
 * matter how many ticks notice it. Push delivery is S6.1/S6.2's job, off this row.
 */
export async function alertStaleTick(
  db: Db,
  info: { lastTickAt: number; now: Date },
): Promise<void> {
  const admins = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.role, "admin"), eq(member.status, "active")));
  if (admins.length === 0) return;
  const since = new Date(info.lastTickAt).toISOString();
  await db
    .insert(notification)
    .values(
      admins.map((admin) => ({
        id: crypto.randomUUID(),
        memberId: admin.id,
        category: "admin_tasks",
        title: "Scheduled tasks have stopped",
        body: `The club scheduler has not run since ${since}. Reminders and event closing may be delayed.`,
        link: "/admin",
        createdAt: info.now,
        idempotencyKey: `scheduler-stale:${String(info.lastTickAt)}:${admin.id}`,
      })),
    )
    .onConflictDoNothing();
}
