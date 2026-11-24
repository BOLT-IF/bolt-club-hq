import { desc, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { invite } from "../../../db/schema";
import { audit } from "../core/audit";
import { contextMiddleware } from "../core/context";
import type { Tx } from "../core/db/client";
import { requireGuard } from "../core/permissions";
import { SLUG_ALPHABET } from "../events/slugs";
import type { AppEnv } from "../types";

type InviteRow = typeof invite.$inferSelect;
export type InviteState = "active" | "revoked" | "expired" | "used_up";

const DAY_MS = 86_400_000;
export const INVITE_DEFAULTS = { expiresInDays: 14, maxUses: 10 } as const;
const MAX_DAYS = 90;
const MAX_USES = 1000;
/** 24 characters from the 32-letter slug alphabet: 120 bits, unguessable. */
const TOKEN_LENGTH = 24;

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_LENGTH));
  return Array.from(bytes, (b) => SLUG_ALPHABET.charAt(b & 31)).join("");
}

/** Revoked wins over expired, expired over used up. `expires_at` itself is already expired. */
export function inviteState(row: InviteRow, now: Date): InviteState {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  if (row.uses >= row.maxUses) return "used_up";
  return "active";
}

const view = (row: InviteRow, now: Date) => ({
  id: row.id,
  token: row.token,
  expiresAt: row.expiresAt,
  maxUses: row.maxUses,
  uses: row.uses,
  revokedAt: row.revokedAt,
  state: inviteState(row, now),
});

/** JSON object body, `{}` when absent, null when malformed. */
export async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const intIn = (value: unknown, fallback: number, max: number): number | null => {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : null;
};

/**
 * Locks the invite with `token` and takes one use, or says why it can't. The row lock makes
 * the last use go to exactly one of two concurrent joiners.
 */
export async function consumeInvite(
  tx: Tx,
  token: string,
  now: Date,
): Promise<{ ok: true; id: string } | { ok: false; error: "not_found" | InviteState }> {
  const [row] = await tx.select().from(invite).where(eq(invite.token, token)).for("update");
  if (!row) return { ok: false, error: "not_found" };
  const state = inviteState(row, now);
  if (state !== "active") return { ok: false, error: state };
  await tx
    .update(invite)
    .set({ uses: row.uses + 1 })
    .where(eq(invite.id, row.id));
  return { ok: true, id: row.id };
}

/** Invites (S1.3): admin only. Mounted from members/routes.ts. */
export const invitesRoutes = new Hono<AppEnv>()
  // "/invites/*" also matches "/invites"; scoped, never "*" (W2 contract correction).
  .use("/invites/*", contextMiddleware())
  .get("/invites", requireGuard("admin"), async (c) => {
    const now = c.var.clock.now();
    const rows = await c.var.db.select().from(invite).orderBy(desc(invite.expiresAt));
    return c.json({ invites: rows.map((r) => view(r, now)) });
  })
  .post("/invites", requireGuard("admin"), async (c) => {
    const actor = c.var.actor;
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const input = await readBody(c);
    if (!input) return c.json({ error: "invalid_body" }, 400);
    const days = intIn(input.expiresInDays, INVITE_DEFAULTS.expiresInDays, MAX_DAYS);
    const maxUses = intIn(input.maxUses, INVITE_DEFAULTS.maxUses, MAX_USES);
    if (days === null) return c.json({ error: "invalid_expiry" }, 400);
    if (maxUses === null) return c.json({ error: "invalid_max_uses" }, 400);

    const now = c.var.clock.now();
    const row = await c.var.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(invite)
        .values({
          id: `inv_${crypto.randomUUID()}`,
          token: newToken(),
          createdBy: actor.id,
          expiresAt: new Date(now.getTime() + days * DAY_MS),
          maxUses,
        })
        .returning();
      if (!created) throw new Error("invite insert returned no row");
      await audit(
        tx,
        c.var.clock,
        {
          actorId: actor.id,
          action: "invite.create",
          entity: "invite",
          entityId: created.id,
          after: { expiresAt: created.expiresAt, maxUses },
        },
        crypto.randomUUID(),
      );
      return created;
    });
    return c.json({ invite: view(row, now) }, 201);
  })
  .delete("/invites/:id", requireGuard("admin"), async (c) => {
    const actor = c.var.actor;
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const id = c.req.param("id");
    const now = c.var.clock.now();
    const row = await c.var.db.transaction(async (tx) => {
      const [before] = await tx.select().from(invite).where(eq(invite.id, id)).for("update");
      if (!before || before.revokedAt) return before ?? null;
      const [after] = await tx
        .update(invite)
        .set({ revokedAt: now })
        .where(eq(invite.id, id))
        .returning();
      await audit(
        tx,
        c.var.clock,
        { actorId: actor.id, action: "invite.revoke", entity: "invite", entityId: id },
        crypto.randomUUID(),
      );
      return after ?? null;
    });
    return row ? c.json({ invite: view(row, now) }) : c.json({ error: "not_found" }, 404);
  });
