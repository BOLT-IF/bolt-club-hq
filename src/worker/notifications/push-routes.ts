import { and, count, countDistinct, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { member, pushSubscription } from "../../../db/schema";
import { contextMiddleware } from "../core/context";
import { requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
// Registers the push sender tick hook. The route registry imports every routes.ts at
// start-up, so this module (mounted from routes.ts) is the load point for the hook.
import "./push-cron";

function actorId(c: Context<AppEnv>): string {
  const actor = c.var.actor;
  if (!actor) throw new Error("push: guard let a request through without an actor");
  return actor.id;
}

const MAX_FIELD = 2048;
const str = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_FIELD;

/** A browser `PushSubscription.toJSON()`; the endpoint must be https (RFC 8030). */
function parseSubscription(body: unknown) {
  const { endpoint, keys, userAgent } = (body ?? {}) as Record<string, unknown>;
  const { p256dh, auth } = (keys ?? {}) as Record<string, unknown>;
  if (!str(endpoint) || !str(p256dh) || !str(auth)) return null;
  try {
    if (new URL(endpoint).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    endpoint,
    keys: { p256dh, auth },
    userAgent: str(userAgent) ? userAgent.slice(0, 256) : null,
  };
}

/**
 * Push subscriptions (S6.2). Mounted from `routes.ts` with `.route("/", pushRoutes)`.
 * Paths are relative to /api/v1. Context middleware is scoped to these paths only.
 */
const pushRoutes = new Hono<AppEnv>()
  .use("/push/*", contextMiddleware())
  .use("/admin/push-coverage", contextMiddleware())
  // The public key the browser needs for `pushManager.subscribe`. Not secret, but members only.
  .get("/push/vapid-public-key", requireGuard("member"), (c) => {
    const key: unknown = Reflect.get(c.env, "VAPID_PUBLIC_KEY");
    if (typeof key !== "string" || key === "") return c.json({ error: "push_not_configured" }, 503);
    return c.json({ publicKey: key });
  })
  // Called on every app open (re-subscribe). Upsert on endpoint: the latest member wins,
  // and a fresh subscribe resets the failure count.
  .post("/push/subscriptions", requireGuard("member"), async (c) => {
    const sub = parseSubscription(await c.req.json().catch(() => null));
    if (!sub) return c.json({ error: "invalid_subscription" }, 400);
    const memberId = actorId(c);
    await c.var.db
      .insert(pushSubscription)
      .values({
        id: `sub_${crypto.randomUUID()}`,
        memberId,
        ...sub,
        createdAt: c.var.clock.now(),
      })
      .onConflictDoUpdate({
        target: pushSubscription.endpoint,
        set: { memberId, keys: sub.keys, userAgent: sub.userAgent, failures: 0 },
      });
    return c.json({ ok: true });
  })
  // Naturally idempotent (deletes only the caller's own row), so no Idempotency-Key.
  .delete("/push/subscriptions", requireGuard("member"), async (c) => {
    const { endpoint } = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    if (!str(endpoint)) return c.json({ error: "endpoint_required" }, 400);
    const deleted = await c.var.db
      .delete(pushSubscription)
      .where(
        and(eq(pushSubscription.endpoint, endpoint), eq(pushSubscription.memberId, actorId(c))),
      )
      .returning({ id: pushSubscription.id });
    return c.json({ deleted: deleted.length });
  })
  // PLAN §10: admins see push coverage. Active members with at least one device.
  .get("/admin/push-coverage", requireGuard("admin"), async (c) => {
    const active = eq(member.status, "active");
    const [members] = await c.var.db.select({ n: count() }).from(member).where(active);
    const [covered] = await c.var.db
      .select({ members: countDistinct(pushSubscription.memberId), subs: count() })
      .from(pushSubscription)
      .innerJoin(member, eq(member.id, pushSubscription.memberId))
      .where(active);
    const activeMembers = members?.n ?? 0;
    const membersWithPush = covered?.members ?? 0;
    return c.json({
      activeMembers,
      membersWithPush,
      coveragePercent:
        activeMembers === 0 ? 0 : Math.round((membersWithPush / activeMembers) * 100),
      subscriptions: covered?.subs ?? 0,
    });
  });

export default pushRoutes;
