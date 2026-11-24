import { asc, eq, inArray, sql } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { event, guest, ledgerEntry, member } from "../../../db/schema";
import { LedgerError, type LedgerErrorCode } from "../../domain/ledger";
import { contextMiddleware } from "../core/context";
import { idempotencyKeyMiddleware } from "../core/idempotency";
import { requireGuard } from "../core/permissions";
import type { CurrentMember } from "../core/ports";
import type { AppEnv } from "../types";
import { createLedgerService, type LedgerEntryView } from "./service";

/** Stable `LedgerError.code` → HTTP status. The body is `{ error: code }`. */
export const LEDGER_ERROR_STATUS: Record<LedgerErrorCode, ContentfulStatusCode> = {
  invalid_amount: 400,
  invalid_reason: 400,
  note_required: 400,
  forbidden: 403,
  self_ledger_blocked: 403,
  member_not_found: 404,
  entry_not_found: 404,
  cannot_reverse_reversal: 409,
  already_reversed: 409,
  idempotency_conflict: 409,
};

const NOTE_MAX = 500;

function actorOf(c: Context<AppEnv>): CurrentMember {
  const actor = c.var.actor;
  if (!actor) throw new Error("ledger admin: guard let a request through without an actor");
  return actor;
}

async function body(c: Context): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await c.req.json().catch(() => null);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** Runs a ledger write and maps a refused one to its status. Anything else is a 500. */
async function write(c: Context<AppEnv>, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LedgerError) {
      return c.json({ error: error.code }, LEDGER_ERROR_STATUS[error.code]);
    }
    throw error;
  }
}

/** Money POSTs: one run per `Idempotency-Key` per admin per route (double-tap safe). */
function idempotent(route: string): MiddlewareHandler<AppEnv> {
  return (c, next) =>
    idempotencyKeyMiddleware({ db: c.var.db, route, actorOf: () => actorOf(c).id })(c, next);
}

/** Ledger idempotency key derived from the HTTP key, scoped to the admin and the route. */
function ledgerKey(c: Context<AppEnv>, kind: string): string {
  return `admin-${kind}:${actorOf(c).id}:${c.req.header("Idempotency-Key") ?? ""}`;
}

/** Notes are trimmed and capped; the service enforces "required" where it applies. */
function noteOf(value: unknown): string | null {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > NOTE_MAX) return null;
  return value.trim();
}

/** Still counts in the FIFO allocation and has not been reversed. */
const reversible = (entry: LedgerEntryView, status: string) =>
  entry.kind !== "reversal" && status !== "reversed";

/** A waiver undoes something the member owes: a charge or a positive adjustment. */
const waivable = (entry: LedgerEntryView, status: string) =>
  reversible(entry, status) &&
  entry.amountSek > 0 &&
  (entry.kind === "charge" || entry.kind === "adjustment");

const context = contextMiddleware();
const admin = requireGuard("admin");

/**
 * Admin money (S5.4, PLAN §9): balances, payments, waivers, manual charges and reversals.
 * Every write goes through the ledger service, which re-checks the actor (active admin),
 * applies the self-ledger guard (A11) and audits in the same transaction. Mounted by
 * `routes.ts`. Context is attached per route: this app is mounted at /api/v1.
 */
const adminRoutes = new Hono<AppEnv>();

/** Every member with their balance. Filters ("inactive with balance") are applied client-side. */
adminRoutes.get("/admin/balances", context, admin, async (c) => {
  const rows = await c.var.db
    .select({
      id: member.id,
      displayName: member.displayName,
      paymentRef: member.paymentRef,
      status: member.status,
      balance: sql<string>`coalesce(sum(${ledgerEntry.amountSek}), 0)`,
    })
    .from(member)
    .leftJoin(ledgerEntry, eq(ledgerEntry.memberId, member.id))
    .groupBy(member.id)
    .orderBy(asc(member.displayName), asc(member.id));
  return c.json({
    members: rows.map(({ balance, ...m }) => {
      const balanceSek = Number(balance);
      return {
        ...m,
        balanceSek,
        owedSek: Math.max(balanceSek, 0),
        creditSek: Math.max(-balanceSek, 0),
      };
    }),
  });
});

/** One member's FIFO-itemized ledger, with what an admin may still waive or reverse. */
adminRoutes.get("/admin/balances/:memberId", context, admin, async (c) => {
  const memberId = c.req.param("memberId");
  const [who] = await c.var.db
    .select({
      id: member.id,
      displayName: member.displayName,
      paymentRef: member.paymentRef,
      status: member.status,
    })
    .from(member)
    .where(eq(member.id, memberId));
  if (!who) return c.json({ error: "member_not_found" }, 404);

  const result = await createLedgerService({ db: c.var.db, clock: c.var.clock }).itemize(memberId);
  const eventIds = [...new Set(result.items.flatMap((i) => i.entry.eventId ?? []))];
  const guestIds = [...new Set(result.items.flatMap((i) => i.entry.guestId ?? []))];
  const events =
    eventIds.length === 0
      ? []
      : await c.var.db
          .select({ id: event.id, title: event.title, startsAt: event.startsAt })
          .from(event)
          .where(inArray(event.id, eventIds));
  const guests =
    guestIds.length === 0
      ? []
      : await c.var.db
          .select({ id: guest.id, name: guest.name })
          .from(guest)
          .where(inArray(guest.id, guestIds));
  const eventById = new Map(events.map((e) => [e.id, e]));
  const guestById = new Map(guests.map((g) => [g.id, g]));

  return c.json({
    member: who,
    balanceSek: result.balanceSek,
    owedSek: result.owedSek,
    creditSek: result.creditSek,
    items: result.items.map(({ entry, status, allocatedSek, outstandingSek }) => {
      const ev = entry.eventId ? eventById.get(entry.eventId) : undefined;
      return {
        id: entry.id,
        kind: entry.kind,
        reason: entry.reason,
        amountSek: entry.amountSek,
        status,
        allocatedSek,
        outstandingSek,
        note: entry.note,
        createdAt: new Date(entry.createdAt).toISOString(),
        createdBy: entry.createdBy,
        reversesEntryId: entry.reversesEntryId,
        eventId: entry.eventId,
        eventTitle: ev?.title ?? null,
        eventStartsAt: ev?.startsAt.toISOString() ?? null,
        guestName: (entry.guestId && guestById.get(entry.guestId)?.name) || null,
        waivable: waivable(entry, status),
        reversible: reversible(entry, status),
      };
    }),
  });
});

/** Records a bank/Swish payment: `{ memberId, amountSek (whole kronor > 0), note? }`. */
adminRoutes.post(
  "/admin/payments",
  context,
  admin,
  idempotent("POST /api/v1/admin/payments"),
  async (c) => {
    const input = await body(c);
    const note = noteOf(input?.note);
    if (!input || typeof input.memberId !== "string" || note === null) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const memberId = input.memberId;
    return write(c, async () => {
      const ledger = createLedgerService({ db: c.var.db, clock: c.var.clock });
      const { entryId } = await ledger.recordPayment({
        memberId,
        amountSek: input.amountSek as number,
        note,
        actor: actorOf(c),
        idempotencyKey: ledgerKey(c, "payment"),
      });
      return c.json({ entryId, balanceSek: await ledger.balance(memberId) }, 201);
    });
  },
);

/**
 * Adjustments, all with a required note:
 * - `{ type: "waiver", entryId }` reverses a charge (reason waiver);
 * - `{ type: "waiver", memberId, amountSek }` waives part of the balance (negative adjustment);
 * - `{ type: "charge", memberId, amountSek }` is a manual charge;
 * - `{ type: "reversal", entryId }` undoes any entry, e.g. a payment on the wrong member.
 */
adminRoutes.post(
  "/admin/adjustments",
  context,
  admin,
  idempotent("POST /api/v1/admin/adjustments"),
  async (c) => {
    const input = await body(c);
    const note = noteOf(input?.note);
    if (!input || note === null) return c.json({ error: "invalid_body" }, 400);
    const { type, entryId, memberId, amountSek } = input;
    const actor = actorOf(c);
    const ledger = createLedgerService({ db: c.var.db, clock: c.var.clock });
    const idempotencyKey = ledgerKey(c, "adjustment");
    const done = async (written: { entryId: string }, owner: string) =>
      c.json({ entryId: written.entryId, balanceSek: await ledger.balance(owner) }, 201);

    // Admin-side note rule: every adjustment says why (PLAN §9). Checked before any write.
    if (note === "") return c.json({ error: "note_required" }, 400);

    if ((type === "waiver" || type === "reversal") && typeof entryId === "string") {
      const [entry] = await c.var.db
        .select({
          id: ledgerEntry.id,
          memberId: ledgerEntry.memberId,
          kind: ledgerEntry.kind,
          amountSek: ledgerEntry.amountSek,
        })
        .from(ledgerEntry)
        .where(eq(ledgerEntry.id, entryId));
      if (!entry) return c.json({ error: "entry_not_found" }, 404);
      if (type === "waiver" && !(entry.amountSek > 0 && entry.kind !== "reversal")) {
        return c.json({ error: "not_waivable" }, 409);
      }
      return write(c, async () =>
        done(
          await ledger.reverse({
            entryId,
            note,
            actor,
            idempotencyKey,
            ...(type === "waiver" ? { reason: "waiver" } : {}),
          }),
          entry.memberId,
        ),
      );
    }

    if ((type === "waiver" || type === "charge") && typeof memberId === "string") {
      if (typeof amountSek !== "number" || !Number.isSafeInteger(amountSek) || amountSek <= 0) {
        return c.json({ error: "invalid_amount" }, 400);
      }
      return write(c, async () =>
        done(
          type === "waiver"
            ? await ledger.adjust({
                memberId,
                amountSek: -amountSek,
                reason: "waiver",
                note,
                actor,
                idempotencyKey,
              })
            : await ledger.charge({
                memberId,
                amountSek,
                reason: "manual",
                note,
                actor,
                idempotencyKey,
              }),
          memberId,
        ),
      );
    }

    return c.json({ error: "invalid_body" }, 400);
  },
);

export default adminRoutes;
