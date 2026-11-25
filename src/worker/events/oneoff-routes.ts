import { Hono } from "hono";

import { idempotent } from "../core/idempotency";
import { requireGuard } from "../core/permissions";
import { markDue } from "../scheduler/schedule";
import type { AppEnv } from "../types";
import { eventsDeps } from "./deps";
import { createEvent } from "./model";
import { planOneoff } from "./oneoff-rules";

/**
 * S3.3 one-offs. Mounted inside `events/routes.ts` after its `contextMiddleware()`, so
 * this sub-app adds none of its own (it would open the database twice).
 */
const oneoffRoutes = new Hono<AppEnv>()
  /** What the create form may offer this member. */
  .get("/events/oneoff/options", requireGuard("member"), (c) =>
    c.json({ canSetFee: c.var.actor?.role === "admin" }),
  )
  .post("/events", requireGuard("member"), idempotent("POST /api/v1/events"), async (c) => {
    const actor = c.var.actor;
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const body: unknown = await c.req.json().catch(() => null);
    const plan = planOneoff(actor, body, c.var.clock.now());
    if (!plan.ok) return c.json({ error: plan.error, message: plan.message }, plan.status);

    const row = await createEvent(
      {
        db: c.var.db,
        clock: c.var.clock,
        publishOg: eventsDeps().publishOg(c.env),
        onOgError: (error) => {
          c.var.logger.warn("og_publish_failed", { error: String(error) });
        },
      },
      { ...plan.value, seriesId: null, createdBy: actor.id },
    );
    const kv = (c.env as Partial<Cloudflare.Env> | undefined)?.KV;
    if (kv) {
      try {
        await markDue(kv, row.rsvpCloseAt);
      } catch (error) {
        c.var.logger.warn("mark_due_failed", { error: String(error) });
      }
    }
    return c.json({ event: { id: row.id, slug: row.shareSlug } }, 201);
  });

export default oneoffRoutes;
