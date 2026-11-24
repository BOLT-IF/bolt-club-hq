import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { auditLog, member } from "../../../db/schema";
import { contextMiddleware } from "../core/context";
import { requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** A full instant with an explicit offset, so a bare date is never read in the server's zone. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
/** Cursor timestamps keep Postgres' microseconds: rows written with now() differ below 1 ms. */
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** `at` in UTC with microseconds, the sort key a cursor must reproduce exactly. */
const atMicros = sql<string>`to_char(${auditLog.at} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const encodeCursor = (at: string, id: string) => btoa(JSON.stringify([at, id])).replace(/=+$/, "");

function decodeCursor(raw: string): { at: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(atob(raw));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      CURSOR_AT.test(parsed[0])
    ) {
      return { at: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  return null;
}

function instant(raw: string | undefined): Date | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!INSTANT.test(raw)) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Audit rows store JSON text; anything that does not parse is returned as written. */
function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const routes = new Hono<AppEnv>()
  // Scoped to this area's path: the sub-app is mounted at /api/v1 (see DECISIONS, W2 contract).
  .use("/admin/audit", contextMiddleware())
  /**
   * Newest first, keyset-paginated on (at, id): rows written between two page loads never shift
   * or repeat the next page. Filters are exact matches combined with AND; `from` is inclusive,
   * `to` exclusive.
   */
  .get("/admin/audit", requireGuard("admin"), async (c) => {
    const q = c.req.query();
    const from = instant(q.from);
    const to = instant(q.to);
    if (from === null || to === null) return c.json({ error: "invalid_date" }, 400);

    let limit = DEFAULT_LIMIT;
    if (q.limit !== undefined) {
      limit = /^\d+$/.test(q.limit) ? Number(q.limit) : 0;
      if (limit < 1 || limit > MAX_LIMIT) return c.json({ error: "invalid_limit" }, 400);
    }

    const cursor = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
    if (cursor === null) return c.json({ error: "invalid_cursor" }, 400);

    const where: SQL[] = [];
    if (q.actor) where.push(eq(auditLog.actorId, q.actor));
    if (q.entity) where.push(eq(auditLog.entity, q.entity));
    if (q.entityId) where.push(eq(auditLog.entityId, q.entityId));
    if (q.action) where.push(eq(auditLog.action, q.action));
    if (from) where.push(gte(auditLog.at, from));
    if (to) where.push(lt(auditLog.at, to));
    if (cursor) {
      where.push(sql`(${auditLog.at}, ${auditLog.id}) < (${cursor.at}::timestamptz, ${cursor.id})`);
    }

    const rows = await c.var.db
      .select({
        id: auditLog.id,
        at: auditLog.at,
        atMicros,
        actorId: auditLog.actorId,
        actorName: member.displayName,
        action: auditLog.action,
        entity: auditLog.entity,
        entityId: auditLog.entityId,
        before: auditLog.before,
        after: auditLog.after,
      })
      .from(auditLog)
      .leftJoin(member, eq(member.id, auditLog.actorId))
      .where(and(...where))
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(limit + 1);

    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return c.json({
      entries: pageRows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        actorId: r.actorId,
        actorName: r.actorName,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        before: parseJson(r.before),
        after: parseJson(r.after),
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.atMicros, last.id) : null,
    });
  });

export default routes;
