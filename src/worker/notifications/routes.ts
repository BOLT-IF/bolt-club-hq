import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { notification } from "../../../db/schema";
import { contextMiddleware } from "../core/context";
import { requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
import pushRoutes from "./push-routes";

/** The guard has run, so an actor exists; fail loudly rather than assert. */
function actorId(c: Context<AppEnv>): string {
  const actor = c.var.actor;
  if (!actor) throw new Error("notifications: guard let a request through without an actor");
  return actor.id;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** A member's own inbox. Every query is scoped to the actor; nothing here takes a member id. */
export default new Hono<AppEnv>()
  // Scoped, not "*": a sub-app's use("*") is mounted at /api/v1/* and would also open the
  // database for every route registered after it (e.g. /probe). See DECISIONS 2026-11-24 (S6.1).
  .use("/notifications", contextMiddleware())
  .use("/notifications/*", contextMiddleware())
  .route("/", pushRoutes)
  .get("/notifications", requireGuard("member"), async (c) => {
    const memberId = actorId(c);
    const requested = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit =
      Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;

    const rows = await c.var.db
      .select()
      .from(notification)
      .where(eq(notification.memberId, memberId))
      .orderBy(desc(notification.createdAt), desc(notification.id))
      .limit(limit);
    const [unread] = await c.var.db
      .select({ n: count() })
      .from(notification)
      .where(and(eq(notification.memberId, memberId), isNull(notification.readAt)));

    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        category: r.category,
        title: r.title,
        body: r.body,
        link: r.link,
        createdAt: r.createdAt.toISOString(),
        readAt: r.readAt?.toISOString() ?? null,
      })),
      unreadCount: unread?.n ?? 0,
    });
  })
  // Naturally idempotent (only unread rows are stamped), so no Idempotency-Key is required.
  .post("/notifications/read", requireGuard("member"), async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const { ids, all } = (body ?? {}) as { ids?: unknown; all?: unknown };
    const idList = Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : null;
    if (all !== true && idList === null) return c.json({ error: "ids_or_all_required" }, 400);

    const mine = and(
      eq(notification.memberId, actorId(c)),
      isNull(notification.readAt),
      all === true || idList === null ? undefined : inArray(notification.id, idList),
    );
    const updated = await c.var.db
      .update(notification)
      .set({ readAt: c.var.clock.now() })
      .where(mine)
      .returning({ id: notification.id });
    return c.json({ updated: updated.length });
  });
