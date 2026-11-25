import { Hono } from "hono";

import { contextMiddleware } from "../core/context";
import { idempotent } from "../core/idempotency";
import { requireActor, requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
import { eraseMember } from "./erasure";
import { exportMemberData } from "./export";
import "./retention";

const actorOf = requireActor;
const context = contextMiddleware();
const idempotentErase = idempotent(
  (c) => `POST /api/v1/admin/members/${c.req.param("id") ?? ""}/erase`,
);

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
