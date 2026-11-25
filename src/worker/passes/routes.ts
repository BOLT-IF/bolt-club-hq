import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { LedgerError } from "../../domain/ledger";
import { contextMiddleware } from "../core/context";
import { idempotencyKeyMiddleware } from "../core/idempotency";
import { requireGuard } from "../core/permissions";
import type { CurrentMember } from "../core/ports";
import { LEDGER_ERROR_STATUS } from "../ledger/admin-routes";
import type { AppEnv } from "../types";
import {
  issuePass,
  listAdminPasses,
  listOffersAndPasses,
  revokePass,
  type ServiceOut,
} from "./model";

const NOTE_MAX = 500;

function actorOf(c: Context<AppEnv>): CurrentMember {
  const actor = c.var.actor;
  if (!actor) throw new Error("passes: guard let a request through without an actor");
  return actor;
}

const context = contextMiddleware();

const idempotent: MiddlewareHandler<AppEnv> = (c, next) =>
  idempotencyKeyMiddleware({
    db: c.var.db,
    route: `${c.req.method} ${c.req.path}`,
    actorOf: () => actorOf(c).id,
  })(c, next);

async function jsonObject(
  c: Context,
  opts: { allowEmpty?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const text = await c.req.text();
  if (text.trim() === "" && opts.allowEmpty) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function run<T>(
  c: Context<AppEnv>,
  successStatus: ContentfulStatusCode,
  fn: () => Promise<ServiceOut<T>>,
): Promise<Response> {
  try {
    const out = await fn();
    return out.ok ? c.json(out.value, successStatus) : c.json(out.body, out.status);
  } catch (error) {
    if (error instanceof LedgerError) {
      return c.json({ error: error.code }, LEDGER_ERROR_STATUS[error.code]);
    }
    throw error;
  }
}

function parsePurchaseBody(
  raw: Record<string, unknown> | null,
): { ok: true; seriesId: string } | { ok: false; error: string } {
  if (!raw) return { ok: false, error: "invalid_body" };
  const unknown = Object.keys(raw).find((k) => k !== "seriesId" && k !== "acceptedTerms");
  if (unknown) return { ok: false, error: "invalid_body" };
  if (typeof raw.seriesId !== "string" || raw.seriesId.trim() === "") {
    return { ok: false, error: "invalid_body" };
  }
  if (raw.acceptedTerms !== undefined && raw.acceptedTerms !== true) {
    return { ok: false, error: "terms_not_accepted" };
  }
  return { ok: true, seriesId: raw.seriesId.trim() };
}

function parseAdminGrantBody(
  raw: Record<string, unknown> | null,
):
  | { ok: true; memberId: string; seriesId: string; priceSek?: number }
  | { ok: false; error: string } {
  if (!raw) return { ok: false, error: "invalid_body" };
  const unknown = Object.keys(raw).find(
    (k) => k !== "memberId" && k !== "seriesId" && k !== "priceSek",
  );
  if (unknown) return { ok: false, error: "invalid_body" };
  if (
    typeof raw.memberId !== "string" ||
    raw.memberId.trim() === "" ||
    typeof raw.seriesId !== "string" ||
    raw.seriesId.trim() === ""
  ) {
    return { ok: false, error: "invalid_body" };
  }
  if (raw.priceSek !== undefined) {
    if (
      typeof raw.priceSek !== "number" ||
      !Number.isSafeInteger(raw.priceSek) ||
      raw.priceSek < 0 ||
      raw.priceSek > 2_147_483_647
    ) {
      return { ok: false, error: "invalid_amount" };
    }
    return {
      ok: true,
      memberId: raw.memberId.trim(),
      seriesId: raw.seriesId.trim(),
      priceSek: raw.priceSek,
    };
  }
  return { ok: true, memberId: raw.memberId.trim(), seriesId: raw.seriesId.trim() };
}

function parseRevokeBody(
  raw: Record<string, unknown> | null,
): { ok: true; note?: string } | { ok: false; error: string } {
  if (!raw) return { ok: false, error: "invalid_body" };
  const unknown = Object.keys(raw).find((k) => k !== "note");
  if (unknown) return { ok: false, error: "invalid_body" };
  if (raw.note === undefined) return { ok: true };
  if (typeof raw.note !== "string" || raw.note.length > NOTE_MAX) {
    return { ok: false, error: "invalid_body" };
  }
  return { ok: true, note: raw.note };
}

/**
 * Season passes (S5.3, PLAN §6.5, §11.6): prorated offers, cap-enforced purchase,
 * admin grants, and unpaid-pass revocation. No refund path exists.
 * Context is attached per route so it never runs on other areas mounted at /api/v1.
 */
export default new Hono<AppEnv>()
  .get("/passes/offers", context, requireGuard("member"), async (c) => {
    const data = await listOffersAndPasses(c.var.db, actorOf(c).id, c.var.clock);
    return c.json(data);
  })

  .post("/passes", context, requireGuard("member"), idempotent, async (c) => {
    const parsed = parsePurchaseBody(await jsonObject(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const actor = actorOf(c);
    return run(c, 201, () =>
      issuePass(c.var.db, c.var.clock, {
        seriesId: parsed.seriesId,
        memberId: actor.id,
        actorId: actor.id,
      }),
    );
  })

  .get("/admin/passes", context, requireGuard("admin"), async (c) => {
    return c.json(await listAdminPasses(c.var.db, c.var.clock));
  })

  .post("/admin/passes", context, requireGuard("admin"), idempotent, async (c) => {
    const parsed = parseAdminGrantBody(await jsonObject(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const actor = actorOf(c);
    return run(c, 201, () =>
      issuePass(c.var.db, c.var.clock, {
        seriesId: parsed.seriesId,
        memberId: parsed.memberId,
        actorId: actor.id,
        grant: {
          actor,
          ...(parsed.priceSek !== undefined ? { customPriceSek: parsed.priceSek } : {}),
        },
      }),
    );
  })

  .post("/admin/passes/:id/revoke", context, requireGuard("admin"), idempotent, async (c) => {
    const parsed = parseRevokeBody(await jsonObject(c, { allowEmpty: true }));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const actor = actorOf(c);
    return run(c, 200, () =>
      revokePass(c.var.db, c.var.clock, {
        passId: c.req.param("id"),
        actor,
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
      }),
    );
  });
