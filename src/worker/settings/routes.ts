import { Hono } from "hono";

import { clubSettings } from "../../../db/schema";
import { audit } from "../core/audit";
import { contextMiddleware } from "../core/context";
import type { Db, Tx } from "../core/db/client";
import { requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
import { DEFAULT_SETTINGS, toPublicSettings, type ClubSettingsValue } from "./model";
import { validateSettingsInput } from "./validation";

/** The settings table holds one row, id 1 (db/schema/club.ts). */
const SINGLETON_ID = 1;

function parseBank(raw: string | null): ClubSettingsValue["bank"] {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ClubSettingsValue["bank"];
  } catch {
    return null;
  }
}

/** jsonb columns come back untyped; null means "never set". */
function orElse<T>(value: unknown, fallback: T): T {
  return value === null || value === undefined ? fallback : (value as T);
}

async function loadSettings(db: Db | Tx): Promise<ClubSettingsValue> {
  const [row] = await db.select().from(clubSettings);
  if (!row) return DEFAULT_SETTINGS;
  return {
    clubName: row.clubName,
    bank: parseBank(row.bankDetails),
    paymentInstructions: row.paymentInstructions,
    quietHours: orElse<ClubSettingsValue["quietHours"]>(row.quietHours, null),
    passUnpaidRevokeDays: row.passUnpaidRevokeDays,
    autoPromoteCutoffMin: row.autoPromoteCutoffMin,
    defaults: orElse<ClubSettingsValue["defaults"]>(row.defaults, {}),
    accountCodes: orElse<ClubSettingsValue["accountCodes"]>(row.accountingAccountCodes, {}),
    rosterAppUrl: row.rosterAppUrl,
  };
}

/**
 * Club settings (S2.3). `/admin/settings` is admin only. `/settings/public` is the member-visible
 * subset; it is a guarded route here, not part of the anonymous `/config` (DECISIONS 2026-11-24).
 *
 * The context middleware is scoped to this area's own two paths. `use("*")` would leak onto every
 * route mounted after this sub-app at /api/v1 (other areas, /config, /probe).
 */
export default new Hono<AppEnv>()
  .use("/admin/settings", contextMiddleware())
  .use("/settings/public", contextMiddleware())
  .get("/admin/settings", requireGuard("admin"), async (c) => c.json(await loadSettings(c.var.db)))
  .put("/admin/settings", requireGuard("admin"), async (c) => {
    const raw: unknown = await c.req.json().catch(() => undefined);
    const parsed = validateSettingsInput(raw);
    if (!parsed.ok) return c.json({ error: "validation", fields: parsed.errors }, 400);

    const next = parsed.value;
    const actorId = c.var.actor?.id ?? null;
    const saved = await c.var.db.transaction(async (tx) => {
      const before = await loadSettings(tx);
      const values = {
        clubName: next.clubName,
        bankDetails: next.bank ? JSON.stringify(next.bank) : null,
        paymentInstructions: next.paymentInstructions,
        quietHours: next.quietHours,
        passUnpaidRevokeDays: next.passUnpaidRevokeDays,
        autoPromoteCutoffMin: next.autoPromoteCutoffMin,
        defaults: next.defaults,
        accountingAccountCodes: next.accountCodes,
        rosterAppUrl: next.rosterAppUrl,
      };
      await tx
        .insert(clubSettings)
        .values({ id: SINGLETON_ID, ...values })
        .onConflictDoUpdate({ target: clubSettings.id, set: values });
      await audit(
        tx,
        c.var.clock,
        {
          actorId,
          action: "settings.update",
          entity: "club_settings",
          entityId: String(SINGLETON_ID),
          before,
          after: next,
        },
        crypto.randomUUID(),
      );
      return next;
    });
    return c.json(saved);
  })
  // allowInactive: exited members still need bank details to settle a balance (PLAN §6.7).
  .get("/settings/public", requireGuard("member", { allowInactive: true }), async (c) =>
    c.json(toPublicSettings(await loadSettings(c.var.db))),
  );
