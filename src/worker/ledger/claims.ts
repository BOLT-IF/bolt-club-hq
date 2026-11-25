import { asc, desc, eq, ne, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { ledgerEntry, member, paymentClaim } from "../../../db/schema";
import { LedgerError } from "../../domain/ledger";
import { audit } from "../core/audit";
import { contextMiddleware } from "../core/context";
import type { Tx } from "../core/db/client";
import { idempotent as createIdempotent } from "../core/idempotency";
import { requireActor, requireGuard } from "../core/permissions";
import type { CurrentMember } from "../core/ports";
import { createNotifyPort } from "../notifications/notify";
import type { AppEnv } from "../types";
import { createLedgerService, ledgerEntryIdFor } from "./service";

const TEXT_MAX = 500;
const MAX_SEK = 2_147_483_647;

type ClaimRow = typeof paymentClaim.$inferSelect;

/** Thrown inside a transaction to roll it back and answer with `error`. */
class Refused extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly error: string,
  ) {
    super(error);
  }
}

const actorOf = requireActor;

async function body(c: Context): Promise<Record<string, unknown>> {
  const parsed: unknown = await c.req.json().catch(() => null);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** Scoped per actor and per concrete path, so one key can't replay across claims. */
const idempotent = createIdempotent((c) => `POST /api/v1${c.req.path}`);

/** The ledger key of the one payment a claim can ever create. */
export const claimPaymentKey = (claimId: string): string => `claim:${claimId}`;

const stockholmDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" });

/** "YYYY-MM-DD" that is a real calendar day, or null. */
function parseDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

const view = (r: ClaimRow) => ({
  id: r.id,
  memberId: r.memberId,
  amountSek: r.amountSek,
  paidOn: r.paidOn.toISOString().slice(0, 10),
  note: r.note,
  status: r.status,
  decidedAt: r.decidedAt?.toISOString() ?? null,
  rejectReason: r.rejectReason,
});

async function respond(c: Context<AppEnv>, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Refused) return c.json({ error: error.error }, error.status);
    if (error instanceof LedgerError) {
      const status = error.code === "forbidden" || error.code === "self_ledger_blocked" ? 403 : 409;
      return c.json({ error: error.code }, status);
    }
    throw error;
  }
}

/** Locks a claim for a decision. Own claims are never decided by their owner (A11). */
async function lockForDecision(tx: Tx, id: string, actor: CurrentMember): Promise<ClaimRow> {
  const [row] = await tx.select().from(paymentClaim).where(eq(paymentClaim.id, id)).for("update");
  if (!row) throw new Refused(404, "claim_not_found");
  if (row.memberId === actor.id) throw new Refused(403, "own_claim");
  return row;
}

const context = contextMiddleware();
const member_ = requireGuard("member", { allowInactive: true });
const admin = requireGuard("admin");

/**
 * Payment claims (S5.5, PLAN §9). A member says "I've paid"; nothing touches the ledger
 * until an admin confirms, which writes exactly one payment keyed `claim:<claimId>`.
 * Mounted by `routes.ts`; context is attached per route (this app sits at /api/v1).
 */
const claimsRoutes = new Hono<AppEnv>();

claimsRoutes.get("/me/payment-claims", context, member_, async (c) => {
  const rows = await c.var.db
    .select()
    .from(paymentClaim)
    .where(eq(paymentClaim.memberId, actorOf(c).id))
    .orderBy(desc(paymentClaim.paidOn), desc(paymentClaim.id));
  return c.json({ claims: rows.map(view) });
});

/** `{ amountSek (whole kronor > 0), paidOn: "YYYY-MM-DD" (not in the future), note? }`. */
claimsRoutes.post("/me/payment-claims", context, member_, idempotent, async (c) => {
  const input = await body(c);
  const amount = input.amountSek;
  const paidOn = parseDay(input.paidOn);
  const note = input.note === undefined || input.note === null ? "" : input.note;
  if (
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > MAX_SEK
  ) {
    return c.json({ error: "invalid_amount" }, 400);
  }
  if (!paidOn || paidOn > stockholmDay.format(c.var.clock.now())) {
    return c.json({ error: "invalid_paid_on" }, 400);
  }
  if (typeof note !== "string" || note.length > TEXT_MAX) {
    return c.json({ error: "invalid_note" }, 400);
  }
  const me = actorOf(c).id;
  // Derived from the HTTP key, so a lost replay record still can't create a second claim.
  const id = `clm_${me}_${c.req.header("Idempotency-Key") ?? ""}`;
  await c.var.db
    .insert(paymentClaim)
    .values({
      id,
      memberId: me,
      amountSek: amount,
      paidOn: new Date(`${paidOn}T00:00:00Z`),
      note: note.trim() === "" ? null : note.trim(),
    })
    .onConflictDoNothing({ target: paymentClaim.id });
  const [row] = await c.var.db.select().from(paymentClaim).where(eq(paymentClaim.id, id));
  if (!row) throw new Error("claims: insert returned no row");
  return c.json(view(row), 201);
});

/** Pending claims (oldest payment first) plus recent decided claims (newest first). */
claimsRoutes.get("/admin/payment-claims", context, admin, async (c) => {
  const me = actorOf(c).id;
  const selectFields = {
    claim: paymentClaim,
    displayName: member.displayName,
    paymentRef: member.paymentRef,
    balance: sql<string>`(select coalesce(sum(${ledgerEntry.amountSek}), 0) from ${ledgerEntry} where ${ledgerEntry.memberId} = ${paymentClaim.memberId})`,
  };
  const mapRow = (r: {
    claim: ClaimRow;
    displayName: string;
    paymentRef: string;
    balance: string;
  }) => ({
    ...view(r.claim),
    displayName: r.displayName,
    paymentRef: r.paymentRef,
    balanceSek: Number(r.balance),
    isOwn: r.claim.memberId === me,
  });

  const [pendingRows, historyRows] = await Promise.all([
    c.var.db
      .select(selectFields)
      .from(paymentClaim)
      .innerJoin(member, eq(member.id, paymentClaim.memberId))
      .where(eq(paymentClaim.status, "pending"))
      .orderBy(asc(paymentClaim.paidOn), asc(paymentClaim.id)),
    c.var.db
      .select(selectFields)
      .from(paymentClaim)
      .innerJoin(member, eq(member.id, paymentClaim.memberId))
      .where(ne(paymentClaim.status, "pending"))
      .orderBy(desc(paymentClaim.decidedAt), desc(paymentClaim.id))
      .limit(50),
  ]);
  return c.json({
    claims: pendingRows.map(mapRow),
    history: historyRows.map(mapRow),
  });
});

/** Confirms a claim: one linked payment, the claim marked confirmed, audit and notify. */
claimsRoutes.post("/admin/payment-claims/:id/confirm", context, admin, idempotent, (c) =>
  respond(c, async () => {
    const actor = actorOf(c);
    const { clock } = c.var;
    const id = c.req.param("id");
    const entryId = await c.var.db.transaction(async (tx) => {
      const claim = await lockForDecision(tx, id, actor);
      if (claim.status === "rejected") throw new Refused(409, "claim_decided");
      // Already confirmed (double tap, second admin): the same payment, nothing new.
      if (claim.status === "confirmed") return ledgerEntryIdFor(claimPaymentKey(id));

      const written = await createLedgerService({ db: tx, clock }).recordPayment({
        memberId: claim.memberId,
        amountSek: claim.amountSek,
        actor,
        idempotencyKey: claimPaymentKey(id),
        paymentClaimId: id,
        note: claim.note ?? "",
      });
      await tx
        .update(paymentClaim)
        .set({ status: "confirmed", decidedBy: actor.id, decidedAt: clock.now() })
        .where(eq(paymentClaim.id, id));
      await audit(
        tx,
        clock,
        {
          actorId: actor.id,
          action: "payment_claim.confirm",
          entity: "payment_claim",
          entityId: id,
          before: { status: "pending" },
          after: { status: "confirmed", entryId: written.entryId, amountSek: claim.amountSek },
        },
        `aud_claim-confirm:${id}`,
      );
      await createNotifyPort({ db: tx, clock }).notify({
        memberId: claim.memberId,
        category: "payment_status",
        title: "Payment confirmed",
        body: `Your payment of ${String(claim.amountSek)} kr has been confirmed.`,
        idempotencyKey: `claim-confirmed:${id}`,
      });
      return written.entryId;
    });
    return c.json({ claimId: id, status: "confirmed", entryId }, 200);
  }),
);

/** Rejects a claim: `{ reason }` is required and sent to the member. No money moves. */
claimsRoutes.post("/admin/payment-claims/:id/reject", context, admin, idempotent, (c) =>
  respond(c, async () => {
    const input = await body(c);
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (reason === "" || reason.length > TEXT_MAX) {
      return c.json({ error: "reason_required" }, 400);
    }
    const actor = actorOf(c);
    const { clock } = c.var;
    const id = c.req.param("id");
    await c.var.db.transaction(async (tx) => {
      const claim = await lockForDecision(tx, id, actor);
      if (claim.status === "confirmed") throw new Refused(409, "claim_decided");
      if (claim.status === "rejected") return; // Already rejected: keep the first reason.

      await tx
        .update(paymentClaim)
        .set({
          status: "rejected",
          decidedBy: actor.id,
          decidedAt: clock.now(),
          rejectReason: reason,
        })
        .where(eq(paymentClaim.id, id));
      await audit(
        tx,
        clock,
        {
          actorId: actor.id,
          action: "payment_claim.reject",
          entity: "payment_claim",
          entityId: id,
          before: { status: "pending" },
          after: { status: "rejected", reason },
        },
        `aud_claim-reject:${id}`,
      );
      await createNotifyPort({ db: tx, clock }).notify({
        memberId: claim.memberId,
        category: "payment_status",
        title: "Payment claim rejected",
        body: `Your ${String(claim.amountSek)} kr payment claim was rejected: ${reason}`,
        link: "/money/claims",
        idempotencyKey: `claim-rejected:${id}`,
      });
    });
    return c.json({ claimId: id, status: "rejected" }, 200);
  }),
);

export default claimsRoutes;
