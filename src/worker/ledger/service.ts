import { and, asc, eq, ne, sql } from "drizzle-orm";

import { ledgerEntry, member } from "../../../db/schema";
import {
  entryAmount,
  itemize as itemizeRows,
  LedgerError,
  planReversal,
  selfLedgerGuard,
  type ItemizeResult,
  type LedgerKind,
  type LedgerReason,
  type LedgerRow,
} from "../../domain/ledger";
import { audit } from "../core/audit";
import type { Clock } from "../core/clock";
import type { Db, Tx } from "../core/db/client";
import type { CurrentMember } from "../core/ports";

/** Deterministic row id for an idempotency key; a retry can find "its" entry from the key alone. */
export function ledgerEntryIdFor(idempotencyKey: string): string {
  return `led_${idempotencyKey}`;
}

/** A ledger row as the service returns it: the domain shape plus the context columns. */
export interface LedgerEntryView extends LedgerRow {
  memberId: string;
  note: string;
  eventId: string | null;
  passId: string | null;
  guestId: string | null;
  paymentClaimId: string | null;
  createdBy: string;
}

export interface WriteResult {
  entryId: string;
  /** False when the idempotency key had already been used: nothing was written. */
  created: boolean;
}

interface Context {
  eventId?: string | null;
  passId?: string | null;
  guestId?: string | null;
  note?: string;
}

export interface ChargeInput extends Context {
  memberId: string;
  amountSek: number;
  /** pass, adhoc, guest or manual. */
  reason: string;
  idempotencyKey: string;
  /** Set for an admin-entered charge. Omitted for system charges (close, pass purchase). */
  actor?: CurrentMember;
}

export interface RecordPaymentInput {
  memberId: string;
  amountSek: number;
  actor: CurrentMember;
  idempotencyKey: string;
  paymentClaimId?: string | null;
  note?: string;
}

export interface AdjustInput {
  memberId: string;
  /** Signed, non-zero whole kronor. A waiver must be negative. */
  amountSek: number;
  /** waiver, manual or opening_balance. */
  reason: string;
  /** Required: every adjustment says why. */
  note: string;
  actor: CurrentMember;
  idempotencyKey: string;
}

export interface ReverseInput {
  entryId: string;
  idempotencyKey: string;
  /** Set when an admin reverses by hand. Omitted for system reversals (refill, cancel, revoke). */
  actor?: CurrentMember;
  /** Defaults to the original entry's reason. */
  reason?: string;
  /** Required for an admin reversal and for reason "waiver". */
  note?: string;
}

export interface LedgerService {
  charge(input: ChargeInput): Promise<WriteResult>;
  recordPayment(input: RecordPaymentInput): Promise<WriteResult>;
  adjust(input: AdjustInput): Promise<WriteResult>;
  reverse(input: ReverseInput): Promise<WriteResult>;
  /** Σ amount for the member (kronor, positive = owes). */
  balance(memberId: string): Promise<number>;
  /** FIFO itemization of the member's entries. */
  itemize(memberId: string): Promise<ItemizeResult<LedgerEntryView>>;
}

export interface LedgerDeps {
  /** Pass a transaction to commit or roll back with the caller's work (e.g. event close). */
  db: Db | Tx;
  clock: Clock;
}

const CHARGE_REASONS: ReadonlySet<string> = new Set(["pass", "adhoc", "guest", "manual"]);
const ADJUST_REASONS: ReadonlySet<string> = new Set(["waiver", "manual", "opening_balance"]);
const REVERSAL_REASONS: ReadonlySet<string> = new Set(["waiver", "revocation", "manual"]);

type Row = typeof ledgerEntry.$inferSelect;

interface NewEntry {
  memberId: string;
  kind: LedgerKind;
  amountSek: number;
  reason: LedgerReason;
  note: string;
  createdBy: string;
  idempotencyKey: string;
  eventId?: string | null;
  passId?: string | null;
  guestId?: string | null;
  paymentClaimId?: string | null;
  reversesEntryId?: string | null;
}

function sameEntry(existing: Row, wanted: NewEntry): boolean {
  return (
    existing.memberId === wanted.memberId &&
    existing.kind === wanted.kind &&
    existing.amountSek === wanted.amountSek &&
    existing.reason === wanted.reason &&
    existing.eventId === (wanted.eventId ?? null) &&
    existing.passId === (wanted.passId ?? null) &&
    existing.guestId === (wanted.guestId ?? null) &&
    existing.paymentClaimId === (wanted.paymentClaimId ?? null) &&
    existing.reversesEntryId === (wanted.reversesEntryId ?? null)
  );
}

function toView(row: Row): LedgerEntryView {
  return {
    id: row.id,
    memberId: row.memberId,
    kind: row.kind,
    amountSek: row.amountSek,
    reason: row.reason,
    createdAt: row.createdAt.getTime(),
    reversesEntryId: row.reversesEntryId,
    note: row.note,
    eventId: row.eventId,
    passId: row.passId,
    guestId: row.guestId,
    paymentClaimId: row.paymentClaimId,
    createdBy: row.createdBy,
  };
}

/**
 * Ledger service (S5.1). Every write is one transaction, carries an idempotency key and
 * appends a row (the table is append-only). A repeated key writes nothing and returns the
 * original entry; the same key with different content is an `idempotency_conflict`.
 *
 * Writes with an `actor` are admin actions: the actor must be an active admin, the
 * self-ledger guard applies (PLAN A11) and an audit row is written in the same
 * transaction. Writes without an actor are system writes (close, passes, refills) and
 * are attributed to the member whose ledger they touch.
 */
export function createLedgerService(deps: LedgerDeps): LedgerService {
  const { db, clock } = deps;

  async function requireAdmin(tx: Tx, actor: CurrentMember, memberId: string): Promise<boolean> {
    if (actor.role !== "admin" || actor.status !== "active") {
      throw new LedgerError("forbidden", "only an active admin can write on a ledger by hand");
    }
    let otherActiveAdmins = 0;
    if (actor.id === memberId) {
      const [others] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(member)
        .where(and(eq(member.role, "admin"), eq(member.status, "active"), ne(member.id, actor.id)));
      otherActiveAdmins = others?.n ?? 0;
    }
    const verdict = selfLedgerGuard({ actorId: actor.id, memberId, otherActiveAdmins });
    if (verdict === "block") {
      throw new LedgerError(
        "self_ledger_blocked",
        "an admin cannot write on their own ledger while another admin exists",
      );
    }
    return verdict === "allow_flagged";
  }

  async function requireMember(tx: Tx, memberId: string): Promise<void> {
    const [found] = await tx.select({ id: member.id }).from(member).where(eq(member.id, memberId));
    if (!found) throw new LedgerError("member_not_found", `no member ${memberId}`);
  }

  /** Appends the row once per key, then audits an admin write in the same transaction. */
  async function append(
    tx: Tx,
    entry: NewEntry,
    admin: { actor: CurrentMember; flagged: boolean; action: string } | null,
  ): Promise<WriteResult> {
    const id = ledgerEntryIdFor(entry.idempotencyKey);
    // Same ON CONFLICT DO NOTHING as core/db/idempotent-insert.ts, but `createdAt` comes
    // from the injected Clock (AGENTS rule 6) instead of the database default.
    const inserted = await tx
      .insert(ledgerEntry)
      .values({ ...entry, id, createdAt: clock.now() })
      .onConflictDoNothing({ target: ledgerEntry.idempotencyKey })
      .returning({ id: ledgerEntry.id });

    if (inserted.length === 0) {
      const [existing] = await tx
        .select()
        .from(ledgerEntry)
        .where(eq(ledgerEntry.idempotencyKey, entry.idempotencyKey));
      if (!existing || !sameEntry(existing, entry)) {
        throw new LedgerError(
          "idempotency_conflict",
          `idempotency key ${entry.idempotencyKey} was used for a different entry`,
        );
      }
      return { entryId: existing.id, created: false };
    }

    if (admin) {
      await audit(
        tx,
        clock,
        {
          actorId: admin.actor.id,
          action: admin.action,
          entity: "ledger_entry",
          entityId: id,
          after: {
            memberId: entry.memberId,
            kind: entry.kind,
            amountSek: entry.amountSek,
            reason: entry.reason,
            note: entry.note,
            reversesEntryId: entry.reversesEntryId ?? null,
            selfLedgerFlagged: admin.flagged,
          },
        },
        `aud_${id}`,
      );
    }
    return { entryId: id, created: true };
  }

  return {
    async charge(input) {
      const amount = entryAmount("charge", input.amountSek);
      if (!CHARGE_REASONS.has(input.reason)) {
        throw new LedgerError("invalid_reason", `"${input.reason}" is not a charge reason`);
      }
      const reason = input.reason as LedgerReason;
      return db.transaction(async (tx) => {
        const flagged = input.actor ? await requireAdmin(tx, input.actor, input.memberId) : false;
        await requireMember(tx, input.memberId);
        return append(
          tx,
          {
            memberId: input.memberId,
            kind: "charge",
            amountSek: amount,
            reason,
            note: input.note ?? "",
            createdBy: input.actor?.id ?? input.memberId,
            idempotencyKey: input.idempotencyKey,
            eventId: input.eventId ?? null,
            passId: input.passId ?? null,
            guestId: input.guestId ?? null,
          },
          input.actor ? { actor: input.actor, flagged, action: "ledger.charge" } : null,
        );
      });
    },

    async recordPayment(input) {
      return db.transaction(async (tx) => {
        const flagged = await requireAdmin(tx, input.actor, input.memberId);
        const amount = entryAmount("payment", input.amountSek);
        await requireMember(tx, input.memberId);
        return append(
          tx,
          {
            memberId: input.memberId,
            kind: "payment",
            amountSek: amount,
            reason: "payment",
            note: input.note ?? "",
            createdBy: input.actor.id,
            idempotencyKey: input.idempotencyKey,
            paymentClaimId: input.paymentClaimId ?? null,
          },
          { actor: input.actor, flagged, action: "ledger.payment" },
        );
      });
    },

    async adjust(input) {
      return db.transaction(async (tx) => {
        const flagged = await requireAdmin(tx, input.actor, input.memberId);
        if (!ADJUST_REASONS.has(input.reason)) {
          throw new LedgerError("invalid_reason", `"${input.reason}" is not an adjustment reason`);
        }
        const reason = input.reason as LedgerReason;
        const amount = entryAmount("adjustment", input.amountSek);
        if (reason === "waiver" && amount > 0) {
          throw new LedgerError("invalid_reason", "a waiver reduces what the member owes");
        }
        const note = input.note.trim();
        if (note === "") throw new LedgerError("note_required", "an adjustment needs a note");
        await requireMember(tx, input.memberId);
        return append(
          tx,
          {
            memberId: input.memberId,
            kind: "adjustment",
            amountSek: amount,
            reason,
            note,
            createdBy: input.actor.id,
            idempotencyKey: input.idempotencyKey,
          },
          { actor: input.actor, flagged, action: "ledger.adjust" },
        );
      });
    },

    async reverse(input) {
      if (input.reason !== undefined && !REVERSAL_REASONS.has(input.reason)) {
        throw new LedgerError("invalid_reason", `"${input.reason}" is not a reversal reason`);
      }
      return db.transaction(async (tx) => {
        // Lock the original so two reversals of one entry (under different keys) run one
        // after the other: the second then sees the first and is refused. The lock is not
        // an UPDATE, so the append-only trigger does not fire.
        const [original] = await tx
          .select()
          .from(ledgerEntry)
          .where(eq(ledgerEntry.id, input.entryId))
          .for("update");
        if (!original) throw new LedgerError("entry_not_found", `no entry ${input.entryId}`);

        const flagged = input.actor
          ? await requireAdmin(tx, input.actor, original.memberId)
          : false;
        const reason = (input.reason ?? original.reason) as LedgerReason;
        const note = (input.note ?? "").trim();
        if ((input.actor !== undefined || reason === "waiver") && note === "") {
          throw new LedgerError("note_required", "a manual reversal or waiver needs a note");
        }

        // A retry with the same key replays the earlier reversal instead of failing.
        const [sameKey] = await tx
          .select()
          .from(ledgerEntry)
          .where(eq(ledgerEntry.idempotencyKey, input.idempotencyKey));
        if (sameKey) {
          if (sameKey.kind !== "reversal" || sameKey.reversesEntryId !== original.id) {
            throw new LedgerError(
              "idempotency_conflict",
              `idempotency key ${input.idempotencyKey} was used for a different entry`,
            );
          }
          return { entryId: sameKey.id, created: false };
        }

        const reversedBy = await tx
          .select({ id: ledgerEntry.id })
          .from(ledgerEntry)
          .where(eq(ledgerEntry.reversesEntryId, original.id));
        const amount = planReversal(
          original,
          reversedBy.map((row) => row.id),
        );

        return append(
          tx,
          {
            memberId: original.memberId,
            kind: "reversal",
            amountSek: amount,
            reason,
            note,
            createdBy: input.actor?.id ?? original.memberId,
            idempotencyKey: input.idempotencyKey,
            eventId: original.eventId,
            passId: original.passId,
            guestId: original.guestId,
            reversesEntryId: original.id,
          },
          input.actor ? { actor: input.actor, flagged, action: "ledger.reverse" } : null,
        );
      });
    },

    async balance(memberId) {
      const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${ledgerEntry.amountSek}), 0)` })
        .from(ledgerEntry)
        .where(eq(ledgerEntry.memberId, memberId));
      return Number(row?.total ?? 0);
    },

    async itemize(memberId) {
      const rows = await db
        .select()
        .from(ledgerEntry)
        .where(eq(ledgerEntry.memberId, memberId))
        .orderBy(asc(ledgerEntry.createdAt), asc(ledgerEntry.id));
      return itemizeRows(rows.map(toView));
    },
  };
}
