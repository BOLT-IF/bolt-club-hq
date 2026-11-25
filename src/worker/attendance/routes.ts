import { Hono } from "hono";

import { contextMiddleware } from "../core/context";
import { idempotent } from "../core/idempotency";
import { requireActor, requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
import "./alert-tick";
import { meAttendanceRoutes } from "./me";
import {
  getAttendance,
  putAttendance,
  type AttendanceItemInput,
  type MarkAttendanceInput,
} from "./model";

const PATH = "/events/:id/attendance";

function parseItemList(raw: unknown): AttendanceItemInput[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const items: AttendanceItemInput[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const obj = entry as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.some((k) => k !== "id" && k !== "attendance")) return null;
    const { id, attendance } = obj;
    if (typeof id !== "string" || id.trim() === "") return null;
    if (attendance !== "attended" && attendance !== "no_show") return null;
    items.push({ id, attendance });
  }
  return items;
}

export function parseAttendanceBody(body: unknown): MarkAttendanceInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "rsvps" && k !== "guests")) return null;
  const raw = body as { rsvps?: unknown; guests?: unknown };
  const rsvps = parseItemList(raw.rsvps);
  const guests = parseItemList(raw.guests);
  if (!rsvps || !guests) return null;
  return { rsvps, guests };
}

const actorOf = requireActor;

export default new Hono<AppEnv>()
  .use(PATH, contextMiddleware())
  .get(PATH, requireGuard("member"), async (c) => {
    const result = await getAttendance(c.var.db, c.var.clock, c.req.param("id"), actorOf(c));
    if (!result.ok) {
      return c.json({ error: result.error }, result.error === "not_found" ? 404 : 403);
    }
    return c.json(result.data);
  })
  .put(PATH, requireGuard("member"), idempotent("PUT /api/v1/events/:id/attendance"), async (c) => {
    const parsed = parseAttendanceBody(await c.req.json().catch(() => null));
    if (!parsed) return c.json({ error: "invalid_body" }, 400);
    const result = await putAttendance(
      c.var.db,
      c.var.clock,
      c.req.param("id"),
      actorOf(c),
      parsed,
    );
    if (!result.ok) {
      if (result.error === "not_found") return c.json({ error: "not_found" }, 404);
      if (result.error === "forbidden" || result.error === "attendance_locked") {
        return c.json({ error: result.error }, 403);
      }
      if (result.error === "event_cancelled") return c.json({ error: "event_cancelled" }, 409);
      return c.json({ error: "invalid_attendee" }, 400);
    }
    return c.json(result.data);
  })
  .route("/", meAttendanceRoutes);
