import { Hono } from "hono";

import { contextMiddleware } from "../core/context";
import { idempotent } from "../core/idempotency";
import { requireActor, requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
import { AudienceError } from "./audience";
import { sendBroadcast } from "./send";
import { parseBroadcast } from "./validate";

export default new Hono<AppEnv>()
  // Scoped, not "*": every area is mounted at /api/v1 (DECISIONS 2026-11-24, W2 contract).
  .use("/admin/broadcasts", contextMiddleware())
  .use("/admin/broadcasts/*", contextMiddleware())
  .post(
    "/admin/broadcasts",
    requireGuard("admin"),
    idempotent("POST /api/v1/admin/broadcasts"),
    async (c) => {
      const parsed = parseBroadcast(await c.req.json().catch(() => null));
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      const actor = requireActor(c).id;
      try {
        // Derived from actor + key, so a retry after a released claim still sends once.
        const id = `${actor}:${c.req.header("Idempotency-Key") ?? ""}`;
        const result = await sendBroadcast(
          { db: c.var.db, clock: c.var.clock },
          { id, actorId: actor, ...parsed.value },
        );
        return c.json(result);
      } catch (error) {
        if (error instanceof AudienceError) return c.json({ error: error.code }, 404);
        throw error;
      }
    },
  );
