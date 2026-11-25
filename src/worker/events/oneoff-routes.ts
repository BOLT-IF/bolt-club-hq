import { and, asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";

import { member, series, term } from "../../../db/schema";
import { idempotent } from "../core/idempotency";
import { requireGuard } from "../core/permissions";
import { createNotifyPort } from "../notifications/notify";
import { markDue } from "../scheduler/schedule";
import type { AppEnv } from "../types";
import { resolveEventAudience } from "./audience";
import { eventsDeps } from "./deps";
import { createEvent } from "./model";
import { planOneoff } from "./oneoff-rules";

const eventTimeFmt = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Stockholm",
});

/**
 * S3.3 one-offs. Mounted inside `events/routes.ts` after its `contextMiddleware()`, so
 * this sub-app adds none of its own (it would open the database twice).
 */
const oneoffRoutes = new Hono<AppEnv>()
  /** What the create form may offer this member (scope + audience group options). */
  .get("/events/oneoff/options", requireGuard("member"), async (c) => {
    const [seriesRows, memberRows] = await Promise.all([
      c.var.db
        .select({ id: series.id, name: series.name, termName: term.name })
        .from(series)
        .innerJoin(term, eq(term.id, series.termId))
        .where(inArray(term.status, ["open_for_passes", "active"]))
        .orderBy(asc(series.weekday), asc(series.startTime), asc(series.name)),
      c.var.db
        .select({ id: member.id, displayName: member.displayName })
        .from(member)
        .where(eq(member.status, "active"))
        .orderBy(asc(member.displayName), asc(member.id)),
    ]);
    return c.json({
      canSetFee: c.var.actor?.role === "admin",
      series: seriesRows,
      members: memberRows,
    });
  })
  .post("/events", requireGuard("member"), idempotent("POST /api/v1/events"), async (c) => {
    const actor = c.var.actor;
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const body: unknown = await c.req.json().catch(() => null);
    const plan = planOneoff(actor, body, c.var.clock.now());
    if (!plan.ok) return c.json({ error: plan.error, message: plan.message }, plan.status);

    if (plan.value.audienceKind === "series" && plan.value.audienceSeriesId) {
      const [found] = await c.var.db
        .select({ id: series.id })
        .from(series)
        .where(eq(series.id, plan.value.audienceSeriesId));
      if (!found) {
        return c.json({ error: "invalid_body", message: "Selected series was not found" }, 400);
      }
    }
    if (plan.value.audienceKind === "members" && plan.value.eligibleMemberIds.length > 0) {
      const active = await c.var.db
        .select({ id: member.id })
        .from(member)
        .where(
          and(inArray(member.id, [...plan.value.eligibleMemberIds]), eq(member.status, "active")),
        );
      if (active.length !== plan.value.eligibleMemberIds.length) {
        return c.json(
          { error: "invalid_body", message: "All selected members must be active club members" },
          400,
        );
      }
    }

    const row = await createEvent(
      {
        db: c.var.db,
        clock: c.var.clock,
        publishOg: eventsDeps().publishOg(c.env),
        onOgError: (error) => {
          c.var.logger.warn("og_publish_failed", { error: String(error) });
        },
      },
      { ...plan.value, seriesId: null, createdBy: actor.id },
    );

    // Notify eligible active members (excluding the organizer who just created it).
    try {
      const recipients = (await resolveEventAudience(c.var.db, row)).filter(
        (id) => id !== actor.id,
      );
      if (recipients.length > 0) {
        const notify = createNotifyPort({ db: c.var.db, clock: c.var.clock });
        const when = eventTimeFmt.format(row.startsAt);
        for (const memberId of recipients) {
          await notify.notify({
            memberId,
            category: "new_events",
            title: "New event",
            body: `${row.title} · ${when}`,
            link: `/events/${row.shareSlug}`,
            idempotencyKey: `new-event:${row.id}:${memberId}`,
          });
        }
      }
    } catch (error) {
      c.var.logger.warn("new_event_notify_failed", { error: String(error) });
    }

    const kv = (c.env as Partial<Cloudflare.Env> | undefined)?.KV;
    if (kv && row.status === "scheduled") {
      try {
        await markDue(kv, row.rsvpCloseAt);
      } catch (error) {
        c.var.logger.warn("mark_due_failed", { error: String(error) });
      }
    }
    return c.json({ event: { id: row.id, slug: row.shareSlug } }, 201);
  });

export default oneoffRoutes;
