import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  event,
  member,
  pass,
  series,
  seriesCaptain,
  seriesDiscountEligible,
  term,
} from "../../../db/schema";
import { resolveTermMembershipPeriod } from "../../domain/club-fee";
import { audit } from "../core/audit";
import { contextMiddleware } from "../core/context";
import type { Db, Tx } from "../core/db/client";
import { idempotent } from "../core/idempotency";
import { requireGuard } from "../core/permissions";
import { randomSlug } from "../events/slugs";
import type { AppEnv } from "../types";
import recurrenceRoutes from "./recurrence-routes";
import { canTransition, derivePassCap } from "./rules";
import {
  CAPTAIN_EDITABLE_FIELDS,
  parseCaptainIds,
  parseClone,
  parseMemberIds,
  parseSeriesCreate,
  parseSeriesPatch,
  parseTermCreate,
  parseTermPatch,
  type SeriesPatchField,
} from "./validate";

type Q = Db | Tx;
type SeriesRow = typeof series.$inferSelect;
type Out<T> = { ok: true; value: T } | { ok: false; status: ContentfulStatusCode; body: object };

const ok = <T>(value: T): Out<T> => ({ ok: true, value });
const fail = (status: ContentfulStatusCode, error: string, extra: object = {}): Out<never> => ({
  ok: false,
  status,
  body: { error, ...extra },
});

const invalid = (c: Context<AppEnv>, detail: string) =>
  c.json({ error: "invalid_input", detail }, 422);

const actorOf = (c: Context<AppEnv>) => {
  const actor = c.var.actor;
  if (!actor) throw new Error("terms route reached without a guard");
  return actor;
};

const jsonBody = async (c: Context<AppEnv>): Promise<unknown> =>
  c.req.json().catch(() => null) as Promise<unknown>;

async function withCaptains(q: Q, rows: readonly SeriesRow[]) {
  if (rows.length === 0) return [];
  const seriesIds = rows.map((r) => r.id);
  const [captains, eligible] = await Promise.all([
    q
      .select({
        seriesId: seriesCaptain.seriesId,
        id: member.id,
        displayName: member.displayName,
      })
      .from(seriesCaptain)
      .innerJoin(member, eq(member.id, seriesCaptain.memberId))
      .where(inArray(seriesCaptain.seriesId, seriesIds))
      .orderBy(asc(member.displayName)),
    q
      .select({
        seriesId: seriesDiscountEligible.seriesId,
        id: member.id,
        displayName: member.displayName,
      })
      .from(seriesDiscountEligible)
      .innerJoin(member, eq(member.id, seriesDiscountEligible.memberId))
      .where(inArray(seriesDiscountEligible.seriesId, seriesIds))
      .orderBy(asc(member.displayName)),
  ]);
  return rows.map((row) => ({
    ...row,
    captains: captains
      .filter((cap) => cap.seriesId === row.id)
      .map(({ id, displayName }) => ({ id, displayName })),
    discountEligible: eligible
      .filter((m) => m.seriesId === row.id)
      .map(({ id, displayName }) => ({ id, displayName })),
  }));
}

async function oneSeries(q: Q, id: string) {
  const [row] = await q.select().from(series).where(eq(series.id, id));
  if (!row) return null;
  return (await withCaptains(q, [row]))[0] ?? null;
}

/** A8: lowest capacity across the series' live events, else the series capacity. */
async function currentPassCap(q: Q, seriesId: string, capacity: number): Promise<number> {
  const events = await q
    .select({ capacity: event.capacity })
    .from(event)
    .where(and(eq(event.seriesId, seriesId), ne(event.status, "cancelled")));
  return derivePassCap(
    capacity,
    events.map((e) => e.capacity),
  );
}

const seriesIdParam = (c: Context) => c.req.param("id");

/**
 * Terms, series, captains and term cloning (S3.1). Recurrence and event generation are S3.2.
 * Context is scoped to this area's paths: a sub-app is mounted at /api/v1, so a "*" would
 * leak onto every route registered after it.
 */
export default new Hono<AppEnv>()
  .use("/terms", contextMiddleware())
  .use("/terms/*", contextMiddleware())
  .use("/series", contextMiddleware())
  .use("/series/*", contextMiddleware())
  .route("/", recurrenceRoutes)

  // ---- Terms (admin) ------------------------------------------------------------------

  .get("/terms", requireGuard("admin"), async (c) => {
    const rows = await c.var.db
      .select({
        id: term.id,
        name: term.name,
        startsOn: term.startsOn,
        endsOn: term.endsOn,
        season: term.season,
        clubYear: term.clubYear,
        status: term.status,
        clonedFromTermId: term.clonedFromTermId,
        // Hand-qualified: drizzle drops table prefixes in single-table selects, which would make
        // the correlated column ambiguous.
        seriesCount: sql<number>`(select count(*)::int from "series" "s" where "s"."term_id" = "term"."id")`,
      })
      .from(term)
      .orderBy(desc(term.startsOn), asc(term.id));
    return c.json({ terms: rows });
  })

  .post("/terms", requireGuard("admin"), async (c) => {
    const parsed = parseTermCreate(await jsonBody(c));
    if (!parsed.ok) return invalid(c, parsed.error);
    const { db, clock } = c.var;
    const actor = actorOf(c);
    const id = crypto.randomUUID();
    const period = resolveTermMembershipPeriod({
      startsOn: parsed.value.startsOn,
      season: parsed.value.season ?? null,
      clubYear: parsed.value.clubYear ?? null,
    });
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(term)
        .values({ id, ...parsed.value, season: period.season, clubYear: period.clubYear })
        .returning();
      await audit(
        tx,
        clock,
        { actorId: actor.id, action: "term.create", entity: "term", entityId: id, after: created },
        crypto.randomUUID(),
      );
      return created;
    });
    return c.json({ term: row }, 201);
  })

  .get("/terms/:id", requireGuard("admin"), async (c) => {
    const [row] = await c.var.db
      .select()
      .from(term)
      .where(eq(term.id, c.req.param("id")));
    if (!row) return c.json({ error: "not_found" }, 404);
    const rows = await c.var.db
      .select()
      .from(series)
      .where(eq(series.termId, row.id))
      .orderBy(asc(series.weekday), asc(series.startTime), asc(series.name));
    return c.json({ term: row, series: await withCaptains(c.var.db, rows) });
  })

  .patch("/terms/:id", requireGuard("admin"), async (c) => {
    const parsed = parseTermPatch(await jsonBody(c));
    if (!parsed.ok) return invalid(c, parsed.error);
    const { db, clock } = c.var;
    const actor = actorOf(c);
    const id = c.req.param("id");
    const patch = parsed.value;

    const out = await db.transaction(async (tx): Promise<Out<typeof term.$inferSelect>> => {
      const [row] = await tx.select().from(term).where(eq(term.id, id)).for("update");
      if (!row) return fail(404, "not_found");

      if (patch.status !== undefined && !canTransition(row.status, patch.status)) {
        return fail(409, "invalid_transition", { from: row.status, to: patch.status });
      }
      const touchesDates = patch.startsOn !== undefined || patch.endsOn !== undefined;
      if (touchesDates && row.status !== "draft") return fail(409, "dates_locked");
      if ((patch.startsOn ?? row.startsOn) >= (patch.endsOn ?? row.endsOn)) {
        return fail(422, "invalid_input", { detail: "startsOn must be before endsOn" });
      }

      const [updated] = await tx.update(term).set(patch).where(eq(term.id, id)).returning();
      if (!updated) return fail(404, "not_found");
      // PLAN §6.5: skip-dates lock when sales open.
      if (patch.status === "open_for_passes") {
        await tx.update(series).set({ skipDatesLocked: true }).where(eq(series.termId, id));
      }
      await audit(
        tx,
        clock,
        {
          actorId: actor.id,
          action: patch.status ? "term.transition" : "term.update",
          entity: "term",
          entityId: id,
          before: row,
          after: updated,
        },
        crypto.randomUUID(),
      );
      return ok(updated);
    });
    return out.ok ? c.json({ term: out.value }) : c.json(out.body, out.status);
  })

  .delete("/terms/:id", requireGuard("admin"), async (c) => {
    const { db, clock } = c.var;
    const actor = actorOf(c);
    const id = c.req.param("id");
    const out = await db.transaction(async (tx): Promise<Out<null>> => {
      const [row] = await tx.select().from(term).where(eq(term.id, id)).for("update");
      if (!row) return fail(404, "not_found");
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(series)
        .where(eq(series.termId, id));
      if (row.status !== "draft" || n > 0) return fail(409, "term_not_deletable");
      await tx.delete(term).where(eq(term.id, id));
      await audit(
        tx,
        clock,
        { actorId: actor.id, action: "term.delete", entity: "term", entityId: id, before: row },
        crypto.randomUUID(),
      );
      return ok(null);
    });
    return out.ok ? c.body(null, 204) : c.json(out.body, out.status);
  })

  .post(
    "/terms/:id/clone",
    requireGuard("admin"),
    idempotent("POST /api/v1/terms/:id/clone"),
    async (c) => {
      const parsed = parseClone(await jsonBody(c));
      if (!parsed.ok) return invalid(c, parsed.error);
      const { db, clock } = c.var;
      const actor = actorOf(c);
      const sourceId = c.req.param("id");

      const out = await db.transaction(async (tx) => {
        const [source] = await tx.select().from(term).where(eq(term.id, sourceId));
        if (!source) return fail(404, "not_found");
        const sourceSeries = await tx.select().from(series).where(eq(series.termId, sourceId));

        const newId = crypto.randomUUID();
        const period = resolveTermMembershipPeriod({
          startsOn: parsed.value.startsOn,
          season: parsed.value.season ?? null,
          clubYear: parsed.value.clubYear ?? null,
        });
        const [created] = await tx
          .insert(term)
          .values({
            id: newId,
            name: parsed.value.name ?? `Copy of ${source.name}`,
            startsOn: parsed.value.startsOn,
            endsOn: parsed.value.endsOn,
            season: period.season,
            clubYear: period.clubYear,
            clonedFromTermId: sourceId,
          })
          .returning();

        // Series only: no events, passes, captains or skip-dates travel with a clone.
        const copies = sourceSeries.map((s) => ({
          id: crypto.randomUUID(),
          termId: newId,
          name: s.name,
          format: s.format,
          level: s.level,
          weekday: s.weekday,
          startTime: s.startTime,
          durationMin: s.durationMin,
          location: s.location,
          capacity: s.capacity,
          passPrice: s.passPrice,
          adhocFee: s.adhocFee,
          maxGuestsDefault: s.maxGuestsDefault,
          rsvpCloseOffsetMin: s.rsvpCloseOffsetMin,
          shareSlug: randomSlug(),
          skipDates: [],
          skipDatesLocked: false,
          passCap: s.capacity,
        }));
        const inserted =
          copies.length > 0 ? await tx.insert(series).values(copies).returning() : [];
        await audit(
          tx,
          clock,
          {
            actorId: actor.id,
            action: "term.clone",
            entity: "term",
            entityId: newId,
            before: { sourceTermId: sourceId },
            after: { term: created, seriesCount: inserted.length },
          },
          crypto.randomUUID(),
        );
        return ok({ term: created, series: await withCaptains(tx, inserted) });
      });
      return out.ok ? c.json(out.value, 201) : c.json(out.body, out.status);
    },
  )

  // ---- Series -------------------------------------------------------------------------

  // Any active member may list; a captain sees only their own series, a plain member none.
  .get("/series", requireGuard("member"), async (c) => {
    const actor = actorOf(c);
    const where =
      actor.role === "admin"
        ? undefined
        : actor.seriesIds.length > 0
          ? inArray(series.id, actor.seriesIds)
          : sql`false`;
    const rows = await c.var.db
      .select()
      .from(series)
      .where(where)
      .orderBy(asc(series.weekday), asc(series.startTime), asc(series.name));
    return c.json({ series: await withCaptains(c.var.db, rows) });
  })

  // Registered before /series/:id so "captain-candidates" is not read as an id.
  .get("/series/captain-candidates", requireGuard("admin"), async (c) => {
    const rows = await c.var.db
      .select({ id: member.id, displayName: member.displayName })
      .from(member)
      .where(eq(member.status, "active"))
      .orderBy(asc(member.displayName));
    return c.json({ members: rows });
  })

  .post("/series", requireGuard("admin"), async (c) => {
    const parsed = parseSeriesCreate(await jsonBody(c));
    if (!parsed.ok) return invalid(c, parsed.error);
    const { discountEligibleIds, ...values } = parsed.value;
    if (
      values.discountedPassPrice !== undefined &&
      values.discountedPassPrice !== null &&
      values.discountedPassPrice > values.passPrice
    ) {
      return invalid(c, "discountedPassPrice cannot exceed passPrice");
    }
    const { db, clock } = c.var;
    const actor = actorOf(c);

    const out = await db.transaction(async (tx) => {
      const [parent] = await tx.select().from(term).where(eq(term.id, values.termId)).for("update");
      if (!parent) return fail(404, "term_not_found");
      if (parent.status === "closed") return fail(409, "term_closed");
      if (discountEligibleIds && discountEligibleIds.length > 0) {
        const active = await tx
          .select({ id: member.id })
          .from(member)
          .where(and(inArray(member.id, discountEligibleIds), eq(member.status, "active")));
        if (active.length !== discountEligibleIds.length) {
          return fail(422, "invalid_discount_members");
        }
      }
      const id = crypto.randomUUID();
      const [created] = await tx
        .insert(series)
        .values({
          id,
          ...values,
          shareSlug: randomSlug(),
          skipDates: [],
          // Skip-dates lock at open_for_passes and stay locked (PLAN §6.5).
          skipDatesLocked: parent.status !== "draft",
          passCap: values.capacity,
        })
        .returning();
      if (discountEligibleIds && discountEligibleIds.length > 0) {
        await tx
          .insert(seriesDiscountEligible)
          .values(discountEligibleIds.map((memberId) => ({ seriesId: id, memberId })));
      }
      await audit(
        tx,
        clock,
        {
          actorId: actor.id,
          action: "series.create",
          entity: "series",
          entityId: id,
          after: created,
        },
        crypto.randomUUID(),
      );
      return ok(await oneSeries(tx, id));
    });
    return out.ok ? c.json({ series: out.value }, 201) : c.json(out.body, out.status);
  })

  .get(
    "/series/:id",
    requireGuard("captain-of-series", { seriesIdOf: seriesIdParam }),
    async (c) => {
      const found = await oneSeries(c.var.db, c.req.param("id"));
      return found ? c.json({ series: found }) : c.json({ error: "not_found" }, 404);
    },
  )

  .patch(
    "/series/:id",
    requireGuard("captain-of-series", { seriesIdOf: seriesIdParam }),
    async (c) => {
      const parsed = parseSeriesPatch(await jsonBody(c));
      if (!parsed.ok) return invalid(c, parsed.error);
      const { db, clock } = c.var;
      const actor = actorOf(c);
      const id = c.req.param("id");

      if (actor.role !== "admin") {
        const denied = Object.keys(parsed.value).filter(
          (key) => !CAPTAIN_EDITABLE_FIELDS.includes(key as SeriesPatchField),
        );
        if (denied.length > 0) return c.json({ error: "forbidden_field", fields: denied }, 403);
      }
      const { overrideCapBelowSold, ...changes } = parsed.value;

      const out = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(series).where(eq(series.id, id)).for("update");
        if (!row) return fail(404, "not_found");
        const [parent] = await tx.select().from(term).where(eq(term.id, row.termId));
        if (parent?.status === "closed") return fail(409, "term_closed");

        const nextPassPrice = changes.passPrice ?? row.passPrice;
        const nextDiscountPrice =
          changes.discountedPassPrice !== undefined
            ? changes.discountedPassPrice
            : row.discountedPassPrice;
        if (nextDiscountPrice !== null && nextDiscountPrice > nextPassPrice) {
          return fail(422, "invalid_input", {
            detail: "discountedPassPrice cannot exceed passPrice",
          });
        }

        const passCap = await currentPassCap(tx, id, changes.capacity ?? row.capacity);
        let overridden = false;
        if (changes.capacity !== undefined && passCap < row.passCap) {
          const [{ n } = { n: 0 }] = await tx
            .select({ n: count() })
            .from(pass)
            .where(and(eq(pass.seriesId, id), eq(pass.status, "active")));
          if (n > passCap) {
            if (overrideCapBelowSold !== true) {
              return fail(409, "cap_below_passes_sold", { passCap, passesSold: n });
            }
            overridden = true;
          }
        }

        await tx
          .update(series)
          .set({ ...changes, passCap })
          .where(eq(series.id, id));
        await audit(
          tx,
          clock,
          {
            actorId: actor.id,
            action: "series.update",
            entity: "series",
            entityId: id,
            before: Object.fromEntries(
              Object.keys(changes).map((key) => [key, row[key as keyof SeriesRow]]),
            ),
            after: { ...changes, passCap, ...(overridden ? { overrideCapBelowSold: true } : {}) },
          },
          crypto.randomUUID(),
        );
        return ok(await oneSeries(tx, id));
      });
      return out.ok ? c.json({ series: out.value }) : c.json(out.body, out.status);
    },
  )

  .delete("/series/:id", requireGuard("admin"), async (c) => {
    const { db, clock } = c.var;
    const actor = actorOf(c);
    const id = c.req.param("id");
    const out = await db.transaction(async (tx): Promise<Out<null>> => {
      const [row] = await tx.select().from(series).where(eq(series.id, id)).for("update");
      if (!row) return fail(404, "not_found");
      const [{ events } = { events: 0 }] = await tx
        .select({ events: count() })
        .from(event)
        .where(eq(event.seriesId, id));
      const [{ passes } = { passes: 0 }] = await tx
        .select({ passes: count() })
        .from(pass)
        .where(eq(pass.seriesId, id));
      if (events > 0 || passes > 0) return fail(409, "series_in_use", { events, passes });
      await tx.delete(seriesCaptain).where(eq(seriesCaptain.seriesId, id));
      await tx.delete(seriesDiscountEligible).where(eq(seriesDiscountEligible.seriesId, id));
      await tx.delete(series).where(eq(series.id, id));
      await audit(
        tx,
        clock,
        { actorId: actor.id, action: "series.delete", entity: "series", entityId: id, before: row },
        crypto.randomUUID(),
      );
      return ok(null);
    });
    return out.ok ? c.body(null, 204) : c.json(out.body, out.status);
  })

  // Admin only: a captain cannot appoint captains, even for their own series.
  .put("/series/:id/captains", requireGuard("admin"), async (c) => {
    const parsed = parseCaptainIds(await jsonBody(c));
    if (!parsed.ok) return invalid(c, parsed.error);
    const { db, clock } = c.var;
    const actor = actorOf(c);
    const id = c.req.param("id");
    const wanted = parsed.value;

    const out = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(series).where(eq(series.id, id)).for("update");
      if (!row) return fail(404, "not_found");
      if (wanted.length > 0) {
        const active = await tx
          .select({ id: member.id })
          .from(member)
          .where(and(inArray(member.id, wanted), eq(member.status, "active")));
        if (active.length !== wanted.length) return fail(422, "invalid_captains");
      }
      const before = await tx
        .select({ memberId: seriesCaptain.memberId })
        .from(seriesCaptain)
        .where(eq(seriesCaptain.seriesId, id));
      await tx.delete(seriesCaptain).where(eq(seriesCaptain.seriesId, id));
      if (wanted.length > 0) {
        await tx
          .insert(seriesCaptain)
          .values(wanted.map((memberId) => ({ seriesId: id, memberId })));
      }
      await audit(
        tx,
        clock,
        {
          actorId: actor.id,
          action: "series.captains",
          entity: "series",
          entityId: id,
          before: before.map((b) => b.memberId),
          after: wanted,
        },
        crypto.randomUUID(),
      );
      return ok(await oneSeries(tx, id));
    });
    return out.ok ? c.json({ series: out.value }) : c.json(out.body, out.status);
  })

  .put("/series/:id/discount-eligible", requireGuard("admin"), async (c) => {
    const parsed = parseMemberIds(await jsonBody(c));
    if (!parsed.ok) return invalid(c, parsed.error);
    const { db, clock } = c.var;
    const actor = actorOf(c);
    const id = c.req.param("id");
    const wanted = parsed.value;

    const out = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(series).where(eq(series.id, id)).for("update");
      if (!row) return fail(404, "not_found");
      if (wanted.length > 0) {
        const active = await tx
          .select({ id: member.id })
          .from(member)
          .where(and(inArray(member.id, wanted), eq(member.status, "active")));
        if (active.length !== wanted.length) return fail(422, "invalid_discount_members");
      }
      const before = await tx
        .select({ memberId: seriesDiscountEligible.memberId })
        .from(seriesDiscountEligible)
        .where(eq(seriesDiscountEligible.seriesId, id));
      await tx.delete(seriesDiscountEligible).where(eq(seriesDiscountEligible.seriesId, id));
      if (wanted.length > 0) {
        await tx
          .insert(seriesDiscountEligible)
          .values(wanted.map((memberId) => ({ seriesId: id, memberId })));
      }
      await audit(
        tx,
        clock,
        {
          actorId: actor.id,
          action: "series.discount_eligible",
          entity: "series",
          entityId: id,
          before: before.map((b) => b.memberId),
          after: wanted,
        },
        crypto.randomUUID(),
      );
      return ok(await oneSeries(tx, id));
    });
    return out.ok ? c.json({ series: out.value }) : c.json(out.body, out.status);
  });
