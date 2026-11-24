import { and, asc, count, eq, ne } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { event, pass, series, term } from "../../../db/schema";
import {
  isoWeekday,
  localParts,
  occurrenceAt,
  weeklyOccurrences,
  type Occurrence,
} from "../../domain/recurrence";
import { audit } from "../core/audit";

import type { Db, Tx } from "../core/db/client";
import { requireGuard } from "../core/permissions";
import { eventsDeps } from "../events/deps";
import { createEvent, type EventRow } from "../events/model";
import { eventOgKey, ogSnapshot } from "../events/rules";
import { markDue } from "../scheduler/schedule";
import type { AppEnv } from "../types";
import { derivePassCap } from "./rules";

type SeriesRow = typeof series.$inferSelect;
type TermRow = typeof term.$inferSelect;
type Out<T> = { ok: true; value: T } | { ok: false; status: ContentfulStatusCode; body: object };

const ok = <T>(value: T): Out<T> => ({ ok: true, value });
const fail = (status: ContentfulStatusCode, error: string, extra: object = {}): Out<never> => ({
  ok: false,
  status,
  body: { error, ...extra },
});

const actorOf = (c: Context<AppEnv>) => {
  const actor = c.var.actor;
  if (!actor) throw new Error("recurrence route reached without a guard");
  return actor;
};

const jsonBody = async (c: Context<AppEnv>): Promise<unknown> =>
  c.req.json().catch(() => null) as Promise<unknown>;

const invalid = (c: Context<AppEnv>, detail: string) =>
  c.json({ error: "invalid_input", detail }, 422);

const seriesIdParam = (c: Context) => c.req.param("id");

/** The occurrence's identity in its series: its local (Stockholm) calendar date. */
const dateOf = (e: { startsAt: Date }) => localParts(e.startsAt).date;

const ruleOf = (s: SeriesRow, t: TermRow, skipDates: readonly string[] = s.skipDates) => ({
  startsOn: t.startsOn,
  endsOn: t.endsOn,
  weekday: s.weekday,
  startTime: s.startTime,
  durationMin: s.durationMin,
  rsvpCloseOffsetMin: s.rsvpCloseOffsetMin,
  skipDates,
});

async function loadSeries(q: Db | Tx, id: string, lock = false) {
  const base = q.select().from(series).where(eq(series.id, id));
  const [row] = lock ? await base.for("update") : await base;
  if (!row) return null;
  const [parent] = await q.select().from(term).where(eq(term.id, row.termId));
  return parent ? { series: row, term: parent } : null;
}

/** A8, recomputed after any capacity change. `override` swaps in one event's new capacity. */
async function passCapFor(
  q: Db | Tx,
  s: SeriesRow,
  override?: { eventId: string; capacity: number },
): Promise<number> {
  const rows = await q
    .select({ id: event.id, capacity: event.capacity })
    .from(event)
    .where(and(eq(event.seriesId, s.id), ne(event.status, "cancelled")));
  return derivePassCap(
    s.capacity,
    rows.map((r) => (r.id === override?.eventId ? override.capacity : r.capacity)),
  );
}

async function passesSold(q: Db | Tx, seriesId: string): Promise<number> {
  const [{ n } = { n: 0 }] = await q
    .select({ n: count() })
    .from(pass)
    .where(and(eq(pass.seriesId, seriesId), eq(pass.status, "active")));
  return n;
}

/** Tells the scheduler about new deadlines. KV is absent in tests; a failure never fails the write. */
async function scheduleClose(c: Context<AppEnv>, deadlines: readonly Date[]): Promise<void> {
  const kv = (c.env as Partial<Cloudflare.Env> | undefined)?.KV;
  if (!kv || deadlines.length === 0) return;
  const earliest = new Date(Math.min(...deadlines.map((d) => d.getTime())));
  try {
    await markDue(kv, earliest);
  } catch (error) {
    c.var.logger.warn("mark_due_failed", { error: String(error) });
  }
}

async function publishOg(c: Context<AppEnv>, rows: readonly EventRow[]): Promise<void> {
  const port = eventsDeps().publishOg(c.env);
  for (const row of rows) {
    try {
      await port.publishOg({ key: eventOgKey(row.shareSlug), html: ogSnapshot(row) });
    } catch (error) {
      c.var.logger.warn("og_publish_failed", { error: String(error) });
    }
  }
}

const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

const whole = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

interface OccurrencePatch {
  location?: string | null;
  maxGuestsPerMember?: number;
  rsvpCloseOffsetMin?: number;
  capacity?: number;
  startTime?: string;
  durationMin?: number;
}

/** Captains run nights; capacity and timing stay with admins (same split as series, DECISIONS S3.1). */
const CAPTAIN_FIELDS: ReadonlyArray<keyof OccurrencePatch> = [
  "location",
  "maxGuestsPerMember",
  "rsvpCloseOffsetMin",
];

function parseOccurrencePatch(
  input: unknown,
): { ok: true; patch: OccurrencePatch; override: boolean } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const patch: OccurrencePatch = {};
  let override = false;
  for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
    if (key === "location" && (v === null || (typeof v === "string" && v.length <= 200))) {
      patch.location = v === null || v.trim() === "" ? null : v.trim();
    } else if (key === "maxGuestsPerMember" && whole(v, 0, 20)) patch.maxGuestsPerMember = v;
    else if (key === "rsvpCloseOffsetMin" && whole(v, 0, 60 * 24 * 30))
      patch.rsvpCloseOffsetMin = v;
    else if (key === "capacity" && whole(v, 1, 1000)) patch.capacity = v;
    else if (key === "durationMin" && whole(v, 1, 24 * 60)) patch.durationMin = v;
    else if (key === "startTime" && typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
      patch.startTime = v;
    } else if (key === "overrideCapBelowSold" && typeof v === "boolean") override = v;
    else return { ok: false, error: `invalid ${key}` };
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "nothing to change" };
  return { ok: true, patch, override };
}

/**
 * Recurrence, skip-dates and occurrence edits (S3.2). Mounted from terms/routes.ts with
 * `.route("/", …)` after its `/series/*` context middleware, which therefore covers these
 * routes. Adding another `contextMiddleware()` here would open a second connection.
 */
export default new Hono<AppEnv>()
  // The term's planned dates, skipped ones flagged, each with its event once generated.
  .get(
    "/series/:id/occurrences",
    requireGuard("captain-of-series", { seriesIdOf: seriesIdParam }),
    async (c) => {
      const found = await loadSeries(c.var.db, c.req.param("id"));
      if (!found) return c.json({ error: "not_found" }, 404);
      const events = await c.var.db
        .select()
        .from(event)
        .where(eq(event.seriesId, found.series.id))
        .orderBy(asc(event.startsAt));
      const byDate = new Map(events.map((e) => [dateOf(e), e]));
      const skipped = new Set(found.series.skipDates);
      const planned = weeklyOccurrences(ruleOf(found.series, found.term, []));
      const dates = new Set([...planned.map((o) => o.date), ...byDate.keys()]);
      const occurrences = [...dates].sort().map((date) => ({
        date,
        skipped: skipped.has(date),
        event: byDate.get(date) ?? null,
      }));
      return c.json({ series: found.series, term: found.term, occurrences });
    },
  )

  .put("/series/:id/skip-dates", requireGuard("admin"), async (c) => {
    const body = (await jsonBody(c)) as { skipDates?: unknown; overrideLock?: unknown } | null;
    const list = body?.skipDates;
    if (!Array.isArray(list) || list.length > 60 || !list.every(isDate)) {
      return invalid(c, "skipDates must be a list of YYYY-MM-DD dates");
    }
    const extra = Object.keys(body ?? {}).filter((k) => k !== "skipDates" && k !== "overrideLock");
    if (extra.length > 0) return invalid(c, `unknown field: ${extra[0] ?? ""}`);
    if (body?.overrideLock !== undefined && typeof body.overrideLock !== "boolean") {
      return invalid(c, "invalid overrideLock");
    }
    const overrideLock = body?.overrideLock === true;
    const wanted = [...new Set(list)].sort();
    const { db, clock } = c.var;
    const actor = actorOf(c);
    const id = c.req.param("id");

    const out = await db.transaction(async (tx): Promise<Out<SeriesRow>> => {
      const found = await loadSeries(tx, id, true);
      if (!found) return fail(404, "not_found");
      const { series: s, term: t } = found;
      if (t.status === "closed") return fail(409, "term_closed");
      // PLAN §6.5: locked once sales open; an admin may override with a warning.
      if (s.skipDatesLocked && !overrideLock) return fail(409, "skip_dates_locked");
      const bad = wanted.find((d) => d < t.startsOn || d > t.endsOn || isoWeekday(d) !== s.weekday);
      if (bad) {
        return fail(422, "invalid_input", { detail: `${bad} is not a session date of this term` });
      }
      const added = wanted.filter((d) => !s.skipDates.includes(d));
      if (added.length > 0) {
        const live = await tx
          .select({ startsAt: event.startsAt })
          .from(event)
          .where(and(eq(event.seriesId, id), ne(event.status, "cancelled")));
        const clash = live.map(dateOf).filter((d) => added.includes(d));
        // Cancelling a generated night is an event change (S4.4c), not a skip-date edit.
        if (clash.length > 0) return fail(409, "skip_date_has_event", { dates: clash });
      }
      const [updated] = await tx
        .update(series)
        .set({ skipDates: wanted })
        .where(eq(series.id, id))
        .returning();
      if (!updated) return fail(404, "not_found");
      await audit(
        tx,
        clock,
        {
          actorId: actor.id,
          action: "series.skip_dates",
          entity: "series",
          entityId: id,
          before: { skipDates: s.skipDates },
          after: { skipDates: wanted, ...(s.skipDatesLocked ? { overrideLock: true } : {}) },
        },
        crypto.randomUUID(),
      );
      return ok(updated);
    });
    return out.ok
      ? c.json({ skipDates: out.value.skipDates, series: out.value })
      : c.json(out.body, out.status);
  })

  // Idempotent: creates only dates with no event yet (any status), so edits and cancels stay.
  .post("/series/:id/generate-events", requireGuard("admin"), async (c) => {
    const { db, clock } = c.var;
    const actor = actorOf(c);
    const id = c.req.param("id");
    const now = clock.now();

    const out = await db.transaction(async (tx): Promise<Out<EventRow[]>> => {
      // The series row lock serialises concurrent runs, so a date is never generated twice.
      const found = await loadSeries(tx, id, true);
      if (!found) return fail(404, "not_found");
      const { series: s, term: t } = found;
      if (t.status === "closed") return fail(409, "term_closed");

      const existing = await tx
        .select({ startsAt: event.startsAt })
        .from(event)
        .where(eq(event.seriesId, id));
      const taken = new Set(existing.map(dateOf));
      // A night whose RSVP window already closed is history; never create it after the fact.
      const missing = weeklyOccurrences(ruleOf(s, t)).filter(
        (o: Occurrence) => !taken.has(o.date) && o.rsvpCloseAt > now,
      );

      // createEvent nests its transaction as a savepoint of this one.
      const ctx = {
        db: tx as unknown as Db,
        clock,
        publishOg: { publishOg: () => Promise.resolve() },
      };
      const created: EventRow[] = [];
      for (const o of missing) {
        created.push(
          await createEvent(ctx, {
            seriesId: s.id,
            kind: "series",
            createdBy: actor.id,
            title: s.name,
            format: s.format,
            startsAt: o.startsAt,
            endsAt: o.endsAt,
            rsvpCloseAt: o.rsvpCloseAt,
            location: s.location,
            capacity: s.capacity,
            adhocFee: s.adhocFee,
            maxGuestsPerMember: s.maxGuestsDefault,
            allocationMode: "tiered",
          }),
        );
      }
      const passCap = await passCapFor(tx, s);
      if (passCap !== s.passCap) await tx.update(series).set({ passCap }).where(eq(series.id, id));
      await audit(
        tx,
        clock,
        {
          actorId: actor.id,
          action: "series.generate",
          entity: "series",
          entityId: id,
          after: { created: created.map(dateOf), passCap },
        },
        crypto.randomUUID(),
      );
      return ok(created);
    });
    if (!out.ok) return c.json(out.body, out.status);
    await publishOg(c, out.value);
    await scheduleClose(
      c,
      out.value.map((e) => e.rsvpCloseAt),
    );
    return c.json({ created: out.value.length, events: out.value });
  })

  .patch(
    "/series/:id/occurrences/:eventId",
    requireGuard("captain-of-series", { seriesIdOf: seriesIdParam }),
    async (c) => {
      const parsed = parseOccurrencePatch(await jsonBody(c));
      if (!parsed.ok) return invalid(c, parsed.error);
      const { patch, override } = parsed;
      const actor = actorOf(c);
      if (actor.role !== "admin") {
        const denied = Object.keys(patch).filter(
          (k) => !CAPTAIN_FIELDS.includes(k as keyof OccurrencePatch),
        );
        if (denied.length > 0 || override) {
          return c.json({ error: "forbidden_field", fields: denied }, 403);
        }
      }
      const { db, clock } = c.var;
      const seriesId = c.req.param("id");
      const eventId = c.req.param("eventId");
      const now = clock.now();

      const out = await db.transaction(async (tx): Promise<Out<EventRow>> => {
        const found = await loadSeries(tx, seriesId, true);
        if (!found) return fail(404, "not_found");
        const { series: s, term: t } = found;
        const [row] = await tx
          .select()
          .from(event)
          .where(and(eq(event.id, eventId), eq(event.seriesId, seriesId)))
          .for("update");
        if (!row) return fail(404, "not_found");
        if (t.status === "closed") return fail(409, "term_closed");
        // After close, date/time/location changes are material (PLAN §6.6): that is S4.4c.
        if (row.status !== "scheduled" || row.rsvpCloseAt <= now) return fail(409, "event_closed");

        const local = localParts(row.startsAt);
        const startTime = patch.startTime ?? local.time;
        const durationMin =
          patch.durationMin ?? Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000);
        const offset =
          patch.rsvpCloseOffsetMin ??
          Math.round((row.startsAt.getTime() - row.rsvpCloseAt.getTime()) / 60_000);
        const times = occurrenceAt(local.date, startTime, durationMin, offset);
        if (times.rsvpCloseAt <= now)
          return fail(422, "invalid_input", { detail: "RSVP close would be in the past" });

        let passCap = s.passCap;
        let overridden = false;
        if (patch.capacity !== undefined) {
          passCap = await passCapFor(tx, s, { eventId, capacity: patch.capacity });
          const sold = await passesSold(tx, seriesId);
          if (passCap < s.passCap && sold > passCap) {
            if (!override) return fail(409, "cap_below_passes_sold", { passCap, passesSold: sold });
            overridden = true;
          }
        }

        const changes = {
          ...(patch.location !== undefined ? { location: patch.location } : {}),
          ...(patch.maxGuestsPerMember !== undefined
            ? { maxGuestsPerMember: patch.maxGuestsPerMember }
            : {}),
          ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
          startsAt: times.startsAt,
          endsAt: times.endsAt,
          rsvpCloseAt: times.rsvpCloseAt,
        };
        const [updated] = await tx
          .update(event)
          .set(changes)
          .where(eq(event.id, eventId))
          .returning();
        if (!updated) return fail(404, "not_found");
        if (passCap !== s.passCap) {
          await tx.update(series).set({ passCap }).where(eq(series.id, seriesId));
        }
        await audit(
          tx,
          clock,
          {
            actorId: actor.id,
            action: "event.occurrence_update",
            entity: "event",
            entityId: eventId,
            before: {
              location: row.location,
              maxGuestsPerMember: row.maxGuestsPerMember,
              capacity: row.capacity,
              startsAt: row.startsAt,
              endsAt: row.endsAt,
              rsvpCloseAt: row.rsvpCloseAt,
            },
            after: { ...changes, passCap, ...(overridden ? { overrideCapBelowSold: true } : {}) },
          },
          crypto.randomUUID(),
        );
        return ok(updated);
      });
      if (!out.ok) return c.json(out.body, out.status);
      await publishOg(c, [out.value]);
      await scheduleClose(c, [out.value.rsvpCloseAt]);
      return c.json({ event: out.value });
    },
  );
