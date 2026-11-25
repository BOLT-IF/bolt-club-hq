import { and, asc, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { member } from "../../../db/schema";
import { audit } from "../core/audit";
import { contextMiddleware } from "../core/context";
import type { Tx } from "../core/db/client";
import type { CurrentMember } from "../core/ports";
import { requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
import { invitesRoutes } from "./invites";
import { joinRoutes } from "./join";
import { getRsvpCancel } from "./rsvp-cancel";

type MemberRow = typeof member.$inferSelect;

const DISPLAY_NAME_MAX = 80;
const ROSTER_NAME_MAX = 40;
/** Quoted on bank transfers: upper-case letters, digits and dashes, 3 to 40 characters. */
const PAYMENT_REF = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

const adminView = (m: MemberRow) => ({
  id: m.id,
  displayName: m.displayName,
  rosterName: m.rosterName,
  email: m.email,
  role: m.role,
  status: m.status,
  paymentRef: m.paymentRef,
  joinedAt: m.joinedAt,
  leftAt: m.leftAt,
});

const profileView = (m: MemberRow) => ({
  id: m.id,
  displayName: m.displayName,
  rosterName: m.rosterName,
  email: m.email,
  paymentRef: m.paymentRef,
});

type Refusal = { status: 400 | 404 | 409; error: string };

/** Thrown inside a transaction to roll it back and answer with `refusal`. */
class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.error);
  }
}

const refuse = (status: Refusal["status"], error: string): never => {
  throw new Refused({ status, error });
};

async function body(c: Context): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await c.req.json().catch(() => null);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** pg unique_violation, however drizzle wraps it. */
function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) => (e as { code?: unknown } | undefined)?.code;
  return (
    code(error) === "23505" || code((error as { cause?: unknown } | undefined)?.cause) === "23505"
  );
}

/** Runs `fn` in a transaction and turns `Refused` into its JSON answer. */
async function guarded(c: Context<AppEnv>, fn: (tx: Tx) => Promise<Response>): Promise<Response> {
  try {
    return await c.var.db.transaction(fn);
  } catch (error) {
    if (error instanceof Refused)
      return c.json({ error: error.refusal.error }, error.refusal.status);
    throw error;
  }
}

/**
 * Locks every active admin in id order, so two concurrent demotions serialise. After the wait
 * Postgres re-checks the predicate, so a row the first transaction demoted drops out.
 */
async function lockActiveAdmins(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.role, "admin"), eq(member.status, "active")))
    .orderBy(asc(member.id))
    .for("update");
  return rows.map((r) => r.id);
}

async function lockMember(tx: Tx, id: string): Promise<MemberRow> {
  const [row] = await tx.select().from(member).where(eq(member.id, id)).for("update");
  return row ?? refuse(404, "not_found");
}

const isLastAdmin = (admins: string[], target: MemberRow) =>
  target.role === "admin" &&
  target.status === "active" &&
  admins.length === 1 &&
  admins[0] === target.id;

/** The guard already refused anonymous callers; this narrows the type without a `!`. */
function actorOf(c: Context<AppEnv>): CurrentMember {
  const actor = c.var.actor;
  if (!actor) throw new Error("actor missing: route is not behind requireGuard");
  return actor;
}

/** First row of a `.returning()` that must have matched. */
function only<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("expected one row");
  return row;
}

// The context middleware is attached per route, not with `.use("*")`: this sub-app is mounted at
// /api/v1, so a wildcard would also run (and open a DB connection) for other areas' routes.
const context = contextMiddleware();
const routes = new Hono<AppEnv>();

/** Admin member list: every status, with the bank-transfer reference. Never the Clerk id. */
routes.get("/admin/members", context, requireGuard("admin"), async (c) => {
  const rows = await c.var.db
    .select()
    .from(member)
    .orderBy(asc(member.displayName), asc(member.id));
  return c.json({ members: rows.map(adminView) });
});

/** Directory for active members: names only (PLAN A3). */
routes.get("/members", context, requireGuard("member"), async (c) => {
  const rows = await c.var.db
    .select({ id: member.id, displayName: member.displayName, rosterName: member.rosterName })
    .from(member)
    .where(eq(member.status, "active"))
    .orderBy(asc(member.displayName), asc(member.id));
  return c.json({ members: rows });
});

// allowInactive: exited members still need their payment reference to settle balances (PLAN §6.7).
routes.get("/me/profile", context, requireGuard("member", { allowInactive: true }), async (c) => {
  const actor = actorOf(c);
  const [row] = await c.var.db.select().from(member).where(eq(member.id, actor.id));
  return row ? c.json(profileView(row)) : c.json({ error: "not_found" }, 404);
});

/** Profile edits (owner or admin). `paymentRef` is admin only. */
routes.patch(
  "/members/:id",
  context,
  requireGuard("owner-or-admin", { ownerOf: (c) => c.req.param("id") ?? null }),
  async (c) => {
    const actor = actorOf(c);
    const id = c.req.param("id");
    const input = await body(c);
    if (!input) return c.json({ error: "invalid_body" }, 400);
    if (input.paymentRef !== undefined && actor.role !== "admin") {
      return c.json({ error: "forbidden" }, 403);
    }

    const changes: Partial<Pick<MemberRow, "displayName" | "rosterName" | "paymentRef">> = {};
    if (input.displayName !== undefined) {
      const name = typeof input.displayName === "string" ? input.displayName.trim() : "";
      if (name === "" || name.length > DISPLAY_NAME_MAX)
        return c.json({ error: "invalid_display_name" }, 400);
      changes.displayName = name;
    }
    if (input.rosterName !== undefined) {
      const name = typeof input.rosterName === "string" ? input.rosterName.trim() : null;
      if (name === null || name.length > ROSTER_NAME_MAX)
        return c.json({ error: "invalid_roster_name" }, 400);
      changes.rosterName = name === "" ? null : name;
    }
    if (input.paymentRef !== undefined) {
      const ref = typeof input.paymentRef === "string" ? input.paymentRef.trim().toUpperCase() : "";
      if (!PAYMENT_REF.test(ref)) return c.json({ error: "invalid_payment_ref" }, 400);
      changes.paymentRef = ref;
    }
    if (Object.keys(changes).length === 0) return c.json({ error: "empty_patch" }, 400);

    try {
      return await guarded(c, async (tx) => {
        const before = await lockMember(tx, id);
        const changed = (Object.keys(changes) as Array<keyof typeof changes>).filter(
          (k) => changes[k] !== before[k],
        );
        if (changed.length === 0) return c.json(profileView(before));
        const after = only(
          await tx.update(member).set(changes).where(eq(member.id, id)).returning(),
        );
        await audit(
          tx,
          c.var.clock,
          {
            actorId: actor.id,
            action: "member.update",
            entity: "member",
            entityId: id,
            before: Object.fromEntries(changed.map((k) => [k, before[k]])),
            after: Object.fromEntries(changed.map((k) => [k, changes[k]])),
          },
          crypto.randomUUID(),
        );
        return c.json(profileView(after));
      });
    } catch (error) {
      // The unique index is the arbiter under concurrency; the loser lands here.
      if (isUniqueViolation(error)) return c.json({ error: "payment_ref_taken" }, 409);
      throw error;
    }
  },
);

routes.patch("/members/:id/role", context, requireGuard("admin"), async (c) => {
  const actor = actorOf(c);
  const id = c.req.param("id");
  const input = await body(c);
  const role = input?.role;
  if (role !== "member" && role !== "admin") return c.json({ error: "invalid_role" }, 400);

  return guarded(c, async (tx) => {
    const admins = await lockActiveAdmins(tx);
    const before = await lockMember(tx, id);
    if (before.role === role) return c.json(adminView(before));
    if (role === "member" && isLastAdmin(admins, before)) return refuse(409, "last_admin");
    const after = only(await tx.update(member).set({ role }).where(eq(member.id, id)).returning());
    await audit(
      tx,
      c.var.clock,
      {
        actorId: actor.id,
        action: "member.role_change",
        entity: "member",
        entityId: id,
        before: { role: before.role },
        after: { role },
      },
      crypto.randomUUID(),
    );
    return c.json(adminView(after));
  });
});

/**
 * Deactivate / reactivate (PLAN §6.7). Only active and inactive are switched here; pending
 * is S1.3's approval and erased is S2.5's erasure. Deactivating records `left_at` and then
 * cancels future RSVPs through the `rsvp.cancel` port. The cancel runs after the commit and
 * is repeated, with the same key, on every deactivate request, so a failed cancel is
 * finished by retrying.
 */
routes.patch("/members/:id/status", context, requireGuard("admin"), async (c) => {
  const actor = actorOf(c);
  const id = c.req.param("id");
  const input = await body(c);
  const status = input?.status;
  if (status !== "active" && status !== "inactive") return c.json({ error: "invalid_status" }, 400);

  const cancel: { at: Date | null } = { at: null };
  const result = await guarded(c, async (tx) => {
    const admins = await lockActiveAdmins(tx);
    const before = await lockMember(tx, id);
    if (before.status !== "active" && before.status !== "inactive") {
      return refuse(409, "invalid_transition");
    }
    if (status === "inactive" && isLastAdmin(admins, before)) return refuse(409, "last_admin");

    if (status === "inactive") cancel.at = before.leftAt ?? c.var.clock.now();
    if (before.status === status) return c.json(adminView(before));

    const after = only(
      await tx
        .update(member)
        .set({ status, leftAt: status === "inactive" ? cancel.at : null })
        .where(eq(member.id, id))
        .returning(),
    );
    await audit(
      tx,
      c.var.clock,
      {
        actorId: actor.id,
        action: "member.status_change",
        entity: "member",
        entityId: id,
        before: { status: before.status, leftAt: before.leftAt },
        after: { status, leftAt: after.leftAt },
      },
      crypto.randomUUID(),
    );
    return c.json(adminView(after));
  });

  if (result.ok && cancel.at) {
    await getRsvpCancel().cancelFutureRsvps({
      db: c.var.db,
      clock: c.var.clock,
      memberId: id,
      at: cancel.at,
      idempotencyKey: `member-deactivate:${id}:${cancel.at.toISOString()}`,
    });
  }
  return result;
});

/** Direct admin approval for pending accounts (including direct sign-ins without an invite link). */
routes.post("/members/:id/approve", context, requireGuard("admin"), async (c) => {
  const actor = actorOf(c);
  const id = c.req.param("id");
  return guarded(c, async (tx) => {
    const target = await lockMember(tx, id);
    if (target.status === "active") return c.json({ memberId: target.id, status: "active" });
    if (target.status !== "pending") return refuse(409, "invalid_transition");
    const joinedAt = c.var.clock.now();
    await tx.update(member).set({ status: "active", joinedAt }).where(eq(member.id, target.id));
    await audit(
      tx,
      c.var.clock,
      {
        actorId: actor.id,
        action: "member.approve",
        entity: "member",
        entityId: target.id,
        before: { status: "pending" },
        after: { status: "active", joinedAt },
      },
      crypto.randomUUID(),
    );
    return c.json({ memberId: target.id, status: "active" });
  });
});

routes.route("/", invitesRoutes); // S1.3
routes.route("/", joinRoutes); // S1.3

export default routes;
