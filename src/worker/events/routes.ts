import { Hono, type Context } from "hono";

import { contextMiddleware } from "../core/context";
import { requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
import { eventsDeps } from "./deps";
import oneoffRoutes from "./oneoff-routes";
import {
  getEventById,
  getEventBySlug,
  listEvents,
  nextOpenEvent,
  updateEvent,
  type EventPatch,
  type EventRow,
} from "./model";
import { canManageEvent, canSeeAttendees, isReadOnly } from "./rules";

/** The public shape of an event. No `createdBy`: the creator is not shown to other members. */
function toDto(row: EventRow, now: Date) {
  return {
    id: row.id,
    slug: row.shareSlug,
    seriesId: row.seriesId,
    kind: row.kind,
    title: row.title,
    format: row.format,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    location: row.location,
    capacity: row.capacity,
    adhocFee: row.adhocFee,
    maxGuestsPerMember: row.maxGuestsPerMember,
    rsvpCloseAt: row.rsvpCloseAt,
    allocationMode: row.allocationMode,
    status: row.status,
    readOnly: isReadOnly(row, now),
  };
}

function detail(c: Context<AppEnv>, row: EventRow) {
  const actor = c.var.actor;
  return c.json({
    event: toDto(row, c.var.clock.now()),
    viewer: { canManage: canManageEvent(actor, row), canSeeAttendees: canSeeAttendees(actor) },
  });
}

const notFound = (c: Context<AppEnv>) => c.json({ error: "not_found" }, 404);

/** Only these fields are editable here. Anything else is rejected, never silently dropped. */
function parsePatch(body: unknown): EventPatch | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const patch: EventPatch = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === "title" && typeof value === "string" && value.trim() !== "") {
      patch.title = value.trim();
    } else if (key === "location" && (value === null || typeof value === "string")) {
      patch.location = value === null || value.trim() === "" ? null : value.trim();
    } else {
      return null;
    }
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

// The registry mounts every area under /api/v1, so a "*" middleware here would also run for
// other areas' routes (and open the database for /config). Scope it to this area's paths.
export default new Hono<AppEnv>()
  .use("/events/*", contextMiddleware())
  .use("/series/*", contextMiddleware())
  .route("/", oneoffRoutes)
  .get("/events", requireGuard("member"), async (c) => {
    const scope = c.req.query("scope") === "past" ? "past" : "upcoming";
    const now = c.var.clock.now();
    const rows = await listEvents(c.var.db, now, scope);
    return c.json({ events: rows.map((row) => toDto(row, now)) });
  })
  .get("/events/by-slug/:slug", requireGuard("member"), async (c) => {
    const row = await getEventBySlug(c.var.db, c.req.param("slug"));
    return row ? detail(c, row) : notFound(c);
  })
  .get("/series/by-slug/:slug/next", requireGuard("member"), async (c) => {
    const row = await nextOpenEvent(c.var.db, c.req.param("slug"), c.var.clock.now());
    return row ? detail(c, row) : notFound(c);
  })
  .get("/events/:id", requireGuard("member"), async (c) => {
    const row = await getEventById(c.var.db, c.req.param("id"));
    return row ? detail(c, row) : notFound(c);
  })
  .patch("/events/:id", requireGuard("member"), async (c) => {
    const actor = c.var.actor;
    const row = await getEventById(c.var.db, c.req.param("id"));
    if (!row) return notFound(c);
    if (!actor || !canManageEvent(actor, row)) return c.json({ error: "forbidden" }, 403);

    const patch = parsePatch(await c.req.json().catch(() => null));
    if (!patch) return c.json({ error: "invalid_body" }, 400);
    if (isReadOnly(row, c.var.clock.now())) return c.json({ error: "event_read_only" }, 409);

    const updated = await updateEvent(
      {
        db: c.var.db,
        clock: c.var.clock,
        publishOg: eventsDeps().publishOg(c.env),
        onOgError: (error) => {
          c.var.logger.warn("og_publish_failed", { error: String(error) });
        },
      },
      row.id,
      actor.id,
      patch,
    );
    return updated ? detail(c, updated) : notFound(c);
  });
