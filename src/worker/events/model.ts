import { and, asc, desc, eq, gt, lte, or } from "drizzle-orm";

import { event, series } from "../../../db/schema";
import { audit } from "../core/audit";
import type { Clock } from "../core/clock";
import type { Db } from "../core/db/client";
import type { PublishOgPort } from "../core/ports";
import { eventOgKey, isOpenForNext, ogSnapshot } from "./rules";
import { uniqueSlug } from "./slugs";

export type EventRow = typeof event.$inferSelect;

/** Everything a write needs. Other event stories (S3.1 series, S3.2 recurrence, S3.3 one-offs) reuse `createEvent`. */
export interface EventsContext {
  db: Db;
  clock: Clock;
  publishOg: PublishOgPort;
  /** Called when the OG publish fails; the write still succeeds. */
  onOgError?: (error: unknown) => void;
}

export type NewEvent = Omit<
  typeof event.$inferInsert,
  "id" | "shareSlug" | "closedProcessedAt" | "materialChangeAt"
>;

/** Fields S3.0 lets an organizer edit. Capacity, times and fees belong to S3.2 and S4.4c. */
export interface EventPatch {
  title?: string;
  location?: string | null;
}

/** PLAN §7: the KV copy is refreshed on every event write. A KV failure never fails the write. */
async function publishOg(ctx: EventsContext, row: EventRow): Promise<void> {
  try {
    await ctx.publishOg.publishOg({ key: eventOgKey(row.shareSlug), html: ogSnapshot(row) });
  } catch (error) {
    ctx.onOgError?.(error);
  }
}

export async function createEvent(ctx: EventsContext, input: NewEvent): Promise<EventRow> {
  const slug = await uniqueSlug(async (candidate) => {
    const [hit] = await ctx.db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.shareSlug, candidate));
    return hit !== undefined;
  });

  const row = await ctx.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(event)
      .values({ ...input, id: `evt_${crypto.randomUUID()}`, shareSlug: slug })
      .returning();
    if (!created) throw new Error("createEvent: insert returned no row");
    await audit(
      tx,
      ctx.clock,
      {
        actorId: input.createdBy,
        action: "event.create",
        entity: "event",
        entityId: created.id,
        after: { title: created.title, startsAt: created.startsAt },
      },
      `aud_${crypto.randomUUID()}`,
    );
    return created;
  });

  await publishOg(ctx, row);
  return row;
}

/** Returns the updated row, or null when the event does not exist. The caller checks read-only and permissions first. */
export async function updateEvent(
  ctx: EventsContext,
  id: string,
  actorId: string,
  patch: EventPatch,
): Promise<EventRow | null> {
  const row = await ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(event).where(eq(event.id, id));
    if (!before) return null;
    const [after] = await tx.update(event).set(patch).where(eq(event.id, id)).returning();
    if (!after) return null;
    await audit(
      tx,
      ctx.clock,
      {
        actorId,
        action: "event.update",
        entity: "event",
        entityId: id,
        before: { title: before.title, location: before.location },
        after: { title: after.title, location: after.location },
      },
      `aud_${crypto.randomUUID()}`,
    );
    return after;
  });

  if (row) await publishOg(ctx, row);
  return row;
}

export async function getEventById(db: Db, id: string): Promise<EventRow | null> {
  const [row] = await db.select().from(event).where(eq(event.id, id));
  return row ?? null;
}

export async function getEventBySlug(db: Db, slug: string): Promise<EventRow | null> {
  const [row] = await db.select().from(event).where(eq(event.shareSlug, slug));
  return row ?? null;
}

const LIST_LIMIT = 50;

/** Upcoming: not yet ended, soonest first (cancelled ones stay visible). Past: ended or completed, newest first. */
export async function listEvents(
  db: Db,
  now: Date,
  scope: "upcoming" | "past",
): Promise<EventRow[]> {
  if (scope === "upcoming") {
    return db
      .select()
      .from(event)
      .where(
        and(
          gt(event.endsAt, now),
          or(
            eq(event.status, "scheduled"),
            eq(event.status, "closed"),
            eq(event.status, "cancelled"),
          ),
        ),
      )
      .orderBy(asc(event.startsAt))
      .limit(LIST_LIMIT);
  }
  return db
    .select()
    .from(event)
    .where(or(lte(event.endsAt, now), eq(event.status, "completed")))
    .orderBy(desc(event.startsAt))
    .limit(LIST_LIMIT);
}

/** The series' earliest event that is still open for RSVPs, or null (also for an unknown series slug). */
export async function nextOpenEvent(
  db: Db,
  seriesSlug: string,
  now: Date,
): Promise<EventRow | null> {
  const [found] = await db
    .select({ id: series.id })
    .from(series)
    .where(eq(series.shareSlug, seriesSlug));
  if (!found) return null;
  const candidates = await db
    .select()
    .from(event)
    .where(and(eq(event.seriesId, found.id), eq(event.status, "scheduled"), gt(event.endsAt, now)))
    .orderBy(asc(event.startsAt));
  return candidates.find((e) => isOpenForNext(e, now)) ?? null;
}
