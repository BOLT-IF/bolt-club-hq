import { and, asc, eq, gt, lte, ne, or, sql } from "drizzle-orm";

import { event, guest, member, rsvp } from "../../../db/schema";
import { createNotifyPort } from "../notifications/notify";
import { registerTickHook, type TickContext } from "../scheduler/registry";
import { markDue } from "../scheduler/schedule";
import { ATTENDANCE_ALERT_DELAY_MS } from "./model";

export const ATTENDANCE_ALERT_TICK_HOOK = "attendance-unmarked-alert";

function hasUnmarkedAttendanceSql() {
  return or(
    sql`EXISTS (
      SELECT 1 FROM ${rsvp}
      WHERE ${rsvp.eventId} = ${event.id}
        AND ${rsvp.status} = 'confirmed'
        AND ${rsvp.attendance} = 'unknown'
    )`,
    sql`EXISTS (
      SELECT 1 FROM ${guest}
      INNER JOIN ${rsvp} ON ${rsvp.id} = ${guest.rsvpId}
      WHERE ${rsvp.eventId} = ${event.id}
        AND ${guest.status} = 'confirmed'
        AND ${guest.attendance} = 'unknown'
    )`,
  );
}

/**
 * Alerts active admins (`admin_tasks`) when a non-cancelled event still has unmarked
 * confirmed attendees 24h after `endsAt`. Idempotent per event and admin.
 */
export async function runAttendanceAlertTick(
  ctx: Pick<TickContext, "db" | "clock" | "now"> & { kv?: KVNamespace },
): Promise<void> {
  const cutoff = new Date(ctx.now.getTime() - ATTENDANCE_ALERT_DELAY_MS);
  const dueEvents = await ctx.db
    .select({
      id: event.id,
      title: event.title,
      shareSlug: event.shareSlug,
    })
    .from(event)
    .where(
      and(ne(event.status, "cancelled"), lte(event.endsAt, cutoff), hasUnmarkedAttendanceSql()),
    );

  if (dueEvents.length > 0) {
    const admins = await ctx.db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.role, "admin"), eq(member.status, "active")));

    const notify = createNotifyPort({ db: ctx.db, clock: ctx.clock });
    for (const evt of dueEvents) {
      for (const admin of admins) {
        await notify.notify({
          memberId: admin.id,
          category: "admin_tasks",
          title: "Attendance unmarked",
          body: `Attendance for "${evt.title}" is still unmarked 24 hours after the event.`,
          link: `/events/${evt.shareSlug}`,
          idempotencyKey: `attendance-unmarked:${evt.id}:${admin.id}`,
        });
      }
    }
  }

  if (!ctx.kv) return;
  const [next] = await ctx.db
    .select({ endsAt: event.endsAt })
    .from(event)
    .where(and(ne(event.status, "cancelled"), gt(event.endsAt, cutoff), hasUnmarkedAttendanceSql()))
    .orderBy(asc(event.endsAt))
    .limit(1);

  if (!next) return;
  const wakeAt = new Date(
    Math.max(next.endsAt.getTime() + ATTENDANCE_ALERT_DELAY_MS, ctx.now.getTime() + 1),
  );
  await markDue(ctx.kv, wakeAt);
}

registerTickHook(ATTENDANCE_ALERT_TICK_HOOK, runAttendanceAlertTick);
