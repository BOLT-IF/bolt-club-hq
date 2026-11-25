import { asc, eq, sql } from "drizzle-orm";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { ledgerEntry, member } from "../../../db/schema";
import { LedgerError } from "../../domain/ledger";
import { newPaymentRef } from "../auth/members";
import { preprovisionedClerkId } from "../auth/wiring";
import { audit } from "../core/audit";
import type { Clock } from "../core/clock";
import type { Db, Tx } from "../core/db/client";
import type { CurrentMember } from "../core/ports";
import { createLedgerService } from "../ledger/service";
import type { ValidatedImportRow } from "./validate";

export class ImportError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface ImportRowResult {
  row: number;
  memberId: string;
  email: string;
  memberAction: "created" | "existing";
  openingBalanceSek: number;
  openingEntryId: string | null;
  openingEntryCreated: boolean;
}

export interface ImportMembersResult {
  createdMembers: number;
  existingMembers: number;
  openingEntriesCreated: number;
  openingEntriesExisting: number;
  results: ImportRowResult[];
}

export function openingBalanceKey(memberId: string): string {
  return `import-opening:${memberId}`;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) => (e as { code?: unknown } | undefined)?.code;
  return (
    code(error) === "23505" || code((error as { cause?: unknown } | undefined)?.cause) === "23505"
  );
}

async function insertPreprovisionedMember(
  tx: Tx,
  clock: Clock,
  actor: CurrentMember,
  row: ValidatedImportRow,
): Promise<typeof member.$inferSelect> {
  const now = clock.now();
  const memberId = `mem_${crypto.randomUUID()}`;
  const clerkUserId = preprovisionedClerkId(memberId);

  for (let attempt = 1; ; attempt++) {
    const paymentRef = row.paymentRef ?? newPaymentRef();
    try {
      // Savepoint so a rare generated payment_ref collision retries without aborting the batch.
      const inserted = await tx.transaction(async (sp) => {
        const [created] = await sp
          .insert(member)
          .values({
            id: memberId,
            clerkUserId,
            displayName: row.displayName,
            email: row.email,
            rosterName: row.rosterName,
            role: row.role,
            status: row.status,
            paymentRef,
            joinedAt: row.status === "active" ? now : null,
            leftAt: row.status === "inactive" ? now : null,
          })
          .returning();
        if (!created) throw new Error("importer: insert returned no row");
        return created;
      });

      await audit(
        tx,
        clock,
        {
          actorId: actor.id,
          action: "member.import",
          entity: "member",
          entityId: inserted.id,
          after: {
            email: inserted.email,
            displayName: inserted.displayName,
            rosterName: inserted.rosterName,
            role: inserted.role,
            status: inserted.status,
            paymentRef: inserted.paymentRef,
            openingBalanceSek: row.openingBalanceSek,
          },
        },
        crypto.randomUUID(),
      );
      return inserted;
    } catch (error) {
      if (isUniqueViolation(error)) {
        if (row.paymentRef !== null) {
          throw new ImportError(409, "payment_ref_taken");
        }
        if (attempt < 3) continue;
      }
      throw error;
    }
  }
}

/**
 * Imports pre-provisioned members and their opening balances inside one transaction.
 * Matches existing members by case-insensitive email; opening balances use
 * `createLedgerService` with reason `opening_balance` and stable key `import-opening:<memberId>`.
 */
export async function importMembers(deps: {
  db: Db;
  clock: Clock;
  actor: CurrentMember;
  rows: readonly ValidatedImportRow[];
}): Promise<ImportMembersResult> {
  const { db, clock, actor, rows } = deps;

  return db.transaction(async (tx) => {
    const ledger = createLedgerService({ db: tx, clock });
    const results: ImportRowResult[] = [];
    let createdMembers = 0;
    let existingMembers = 0;
    let openingEntriesCreated = 0;
    let openingEntriesExisting = 0;

    for (const row of rows) {
      const [existing] = await tx
        .select()
        .from(member)
        .where(sql`lower(${member.email}) = ${row.email}`)
        .orderBy(asc(member.id))
        .limit(1)
        .for("update");

      if (existing?.status === "erased") {
        throw new ImportError(409, "member_erased");
      }

      const target = existing ?? (await insertPreprovisionedMember(tx, clock, actor, row));
      const memberAction = existing ? "existing" : "created";
      if (existing) existingMembers++;
      else createdMembers++;

      let openingEntryId: string | null = null;
      let openingEntryCreated = false;

      if (row.openingBalanceSek !== 0) {
        const written = await ledger.adjust({
          memberId: target.id,
          amountSek: row.openingBalanceSek,
          reason: "opening_balance",
          note: row.note,
          actor,
          idempotencyKey: openingBalanceKey(target.id),
        });
        openingEntryId = written.entryId;
        openingEntryCreated = written.created;
        if (written.created) openingEntriesCreated++;
        else openingEntriesExisting++;
      } else if (existing) {
        const key = openingBalanceKey(target.id);
        const [prior] = await tx
          .select({ id: ledgerEntry.id })
          .from(ledgerEntry)
          .where(eq(ledgerEntry.idempotencyKey, key))
          .limit(1);
        if (prior) {
          throw new LedgerError(
            "idempotency_conflict",
            `idempotency key ${key} was used for a different entry`,
          );
        }
      }

      results.push({
        row: row.row,
        memberId: target.id,
        email: row.email,
        memberAction,
        openingBalanceSek: row.openingBalanceSek,
        openingEntryId,
        openingEntryCreated,
      });
    }

    return {
      createdMembers,
      existingMembers,
      openingEntriesCreated,
      openingEntriesExisting,
      results,
    };
  });
}
