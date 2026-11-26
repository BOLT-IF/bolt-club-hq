import type { LedgerReason } from "../../domain/ledger";
import { ledgerEntry, member } from "../../../db/schema";
import type { Db, Tx } from "../core/db/client";

let counter = 0;
const nextId = (prefix: string): string =>
  `${prefix}_${String(++counter)}_${crypto.randomUUID().slice(0, 8)}`;

export interface MemberOverrides {
  id?: string;
  role?: "member" | "admin";
  status?: "pending" | "active" | "inactive" | "erased";
  displayName?: string;
}

export async function makeMember(db: Db | Tx, overrides: MemberOverrides = {}) {
  const id = overrides.id ?? nextId("mem");
  const [row] = await db
    .insert(member)
    .values({
      id,
      clerkUserId: `clerk_${id}`,
      displayName: overrides.displayName ?? `Member ${id}`,
      role: overrides.role ?? "member",
      status: overrides.status ?? "active",
      paymentRef: `ref_${id}`,
      joinedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning();
  if (!row) throw new Error("makeMember: insert returned no row");
  return row;
}

export interface LedgerOverrides {
  amountSek: number;
  reason?: LedgerReason;
  kind?: "charge" | "payment" | "reversal" | "adjustment";
  idempotencyKey?: string;
}

export async function makeLedgerEntry(db: Db | Tx, memberId: string, overrides: LedgerOverrides) {
  const id = nextId("led");
  const [row] = await db
    .insert(ledgerEntry)
    .values({
      id,
      memberId,
      kind: overrides.kind ?? "charge",
      amountSek: overrides.amountSek,
      reason: overrides.reason ?? "manual",
      note: "factory",
      createdBy: memberId,
      idempotencyKey: overrides.idempotencyKey ?? `key_${id}`,
    })
    .returning();
  if (!row) throw new Error("makeLedgerEntry: insert returned no row");
  return row;
}
