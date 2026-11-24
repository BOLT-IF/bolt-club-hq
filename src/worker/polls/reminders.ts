import { and, eq, gt, lte } from "drizzle-orm";

import { poll, pollVote } from "../../../db/schema";
import { createNotifyPort } from "../notifications/notify";
import { registerTickHook, type TickContext } from "../scheduler/registry";
import { markDue } from "../scheduler/schedule";
import { activeMemberIds } from "./model";

/** PLAN §10: "Poll closing: 24h before." */
export const CLOSING_REMINDER_MS = 24 * 60 * 60 * 1000;

/** When the closing reminder for a poll is due (never in the past). */
export function reminderDueAt(closesAt: Date, now: Date): Date {
  return new Date(Math.max(closesAt.getTime() - CLOSING_REMINDER_MS, now.getTime()));
}

/** Wakes the scheduler for the poll's closing reminder. No closing date, nothing to do. */
export async function scheduleClosingReminder(
  kv: KVNamespace,
  closesAt: Date | null,
  now: Date,
): Promise<void> {
  if (closesAt === null || closesAt.getTime() <= now.getTime()) return;
  await markDue(kv, reminderDueAt(closesAt, now));
}

/**
 * Notifies active members who have not voted on a poll that closes within 24 h.
 * Idempotent per (poll, member), so every tick in the window may run it safely.
 */
export async function runClosingReminders({
  db,
  clock,
  now,
}: Pick<TickContext, "db" | "clock" | "now">): Promise<void> {
  const closing = await db
    .select()
    .from(poll)
    .where(
      and(
        gt(poll.closesAt, now),
        lte(poll.closesAt, new Date(now.getTime() + CLOSING_REMINDER_MS)),
      ),
    );
  if (closing.length === 0) return;
  const members = await activeMemberIds(db);
  for (const p of closing) {
    const voted = new Set(
      (
        await db
          .selectDistinct({ memberId: pollVote.memberId })
          .from(pollVote)
          .where(eq(pollVote.pollId, p.id))
      ).map((v) => v.memberId),
    );
    const notify = createNotifyPort({ db, clock });
    for (const memberId of members.filter((m) => !voted.has(m))) {
      await notify.notify({
        memberId,
        category: "polls",
        title: "Poll closing soon",
        body: p.question,
        link: `/polls/${p.id}`,
        idempotencyKey: `poll-closing:${p.id}:${memberId}`,
      });
    }
  }
}

registerTickHook("poll-closing-reminders", runClosingReminders);
