import { Hono, type Context, type MiddlewareHandler } from "hono";

import { contextMiddleware } from "../core/context";
import { idempotencyKeyMiddleware } from "../core/idempotency";
import { requireGuard } from "../core/permissions";
import type { CurrentMember } from "../core/ports";
import type { AppEnv } from "../types";
import { eraseMember } from "./erasure";
import { exportMemberData } from "./export";
import "./retention";

function actorOf(c: Context<AppEnv>): CurrentMember {
  const actor = c.var.actor;
  if (!actor) throw new Error("privacy: guard let a request through without an actor");
  return actor;
}

const context = contextMiddleware();

const idempotentErase: MiddlewareHandler<AppEnv> = (c, next) =>
  idempotencyKeyMiddleware({
    db: c.var.db,
    route: `POST /api/v1/admin/members/${c.req.param("id") ?? ""}/erase`,
    actorOf: () => actorOf(c).id,
  })(c, next);

/**
 * Privacy area (S2.5, PLAN §16).
 * Scoped to `/me/export` and `/admin/members/:id/erase`: never `.use("*")` because every
 * area is mounted at `/api/v1`.
 */
export default new Hono<AppEnv>()
  .use("/me/export", context)
  .use("/admin/members/:id/erase", context)
  // allowInactive: exited members can still export their personal data (PLAN §6.7, §16).
  .get("/me/export", requireGuard("member", { allowInactive: true }), async (c) => {
    const actor = actorOf(c);
    const data = await exportMemberData(c.var.db, c.var.clock, actor.id);
    return data ? c.json(data) : c.json({ error: "not_found" }, 404);
  })
  .post("/admin/members/:id/erase", requireGuard("admin"), idempotentErase, async (c) => {
    const actor = actorOf(c);
    const result = await eraseMember(c.var.db, c.var.clock, c.env, {
      targetId: c.req.param("id"),
      actor,
    });
    return result.ok ? c.json({ member: result.member }) : c.json(result.body, result.status);
  });
