import { Hono } from "hono";

import { LedgerError } from "../../domain/ledger";
import { contextMiddleware } from "../core/context";
import { idempotent } from "../core/idempotency";
import { requireActor, requireGuard } from "../core/permissions";
import { LEDGER_ERROR_STATUS } from "../ledger/admin-routes";
import type { AppEnv } from "../types";
import { ImportError, importMembers } from "./service";
import { validateImportBody } from "./validate";

const actorOf = requireActor;

const context = contextMiddleware();
const admin = requireGuard("admin");

/**
 * Admin member import (S11.2, PLAN §14): pre-provisions members with opening
 * balances in one atomic transaction. Mounted at `/api/v1` by `registry.ts`.
 */
const routes = new Hono<AppEnv>();

routes.post(
  "/admin/members/import",
  context,
  admin,
  idempotent("POST /api/v1/admin/members/import"),
  async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = validateImportBody(raw);
    if (!parsed.ok) {
      return c.json({ error: parsed.error, errors: parsed.errors }, 400);
    }

    try {
      const result = await importMembers({
        db: c.var.db,
        clock: c.var.clock,
        actor: actorOf(c),
        rows: parsed.rows,
      });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof ImportError) {
        return c.json({ error: error.code }, error.status);
      }
      if (error instanceof LedgerError) {
        return c.json({ error: error.code }, LEDGER_ERROR_STATUS[error.code]);
      }
      throw error;
    }
  },
);

export default routes;
