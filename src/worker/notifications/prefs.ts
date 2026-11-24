import { eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { member, notificationPref } from "../../../db/schema";
import { requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
import { CATEGORIES, isCategory, type Category } from "./links";

/** Categories this member can set: `admin_tasks` exists for admins only. */
const visibleCategories = (isAdmin: boolean): Category[] =>
  CATEGORIES.filter((c) => c !== "admin_tasks" || isAdmin);

async function readPrefs(c: Context<AppEnv>, memberId: string, isAdmin: boolean) {
  const [me] = await c.var.db
    .select({ globalMute: member.globalMute })
    .from(member)
    .where(eq(member.id, memberId));
  const rows = await c.var.db
    .select({ category: notificationPref.category, muted: notificationPref.muted })
    .from(notificationPref)
    .where(eq(notificationPref.memberId, memberId));
  const muted = new Set(rows.filter((r) => r.muted).map((r) => r.category));
  return {
    globalMute: me?.globalMute ?? false,
    categories: visibleCategories(isAdmin).map((category) => ({
      category,
      muted: muted.has(category),
    })),
  };
}

/**
 * The caller's own mute settings. Mounted by `routes.ts`, whose context middleware covers
 * `/notifications/*`. Nothing here takes a member id.
 */
export default new Hono<AppEnv>()
  .get("/notifications/prefs", requireGuard("member"), async (c) => {
    const actor = c.var.actor;
    if (!actor) throw new Error("prefs: guard let a request through without an actor");
    return c.json(await readPrefs(c, actor.id, actor.role === "admin"));
  })
  // Naturally idempotent (sets absolute values), so no Idempotency-Key is required.
  .put("/notifications/prefs", requireGuard("member"), async (c) => {
    const actor = c.var.actor;
    if (!actor) throw new Error("prefs: guard let a request through without an actor");
    const isAdmin = actor.role === "admin";

    const body: unknown = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "invalid_prefs" }, 400);
    }
    const { globalMute, categories } = body as { globalMute?: unknown; categories?: unknown };
    if (globalMute === undefined && categories === undefined) {
      return c.json({ error: "invalid_prefs" }, 400);
    }
    if (globalMute !== undefined && typeof globalMute !== "boolean") {
      return c.json({ error: "invalid_prefs" }, 400);
    }
    const changes: { category: Category; muted: boolean }[] = [];
    if (categories !== undefined) {
      if (typeof categories !== "object" || categories === null || Array.isArray(categories)) {
        return c.json({ error: "invalid_prefs" }, 400);
      }
      const allowed = visibleCategories(isAdmin);
      for (const [category, muted] of Object.entries(categories)) {
        if (!isCategory(category) || !allowed.includes(category) || typeof muted !== "boolean") {
          return c.json({ error: "invalid_prefs" }, 400);
        }
        changes.push({ category, muted });
      }
    }

    await c.var.db.transaction(async (tx) => {
      if (globalMute !== undefined) {
        await tx.update(member).set({ globalMute }).where(eq(member.id, actor.id));
      }
      if (changes.length > 0) {
        await tx
          .insert(notificationPref)
          .values(changes.map((ch) => ({ memberId: actor.id, ...ch })))
          .onConflictDoUpdate({
            target: [notificationPref.memberId, notificationPref.category],
            set: { muted: sql`excluded.muted` },
          });
      }
    });
    return c.json(await readPrefs(c, actor.id, isAdmin));
  });
