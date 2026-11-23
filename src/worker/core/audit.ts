import { auditLog } from "../../../db/schema";
import type { Clock } from "./clock";
import type { Db, Tx } from "./db/client";

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Writes one audit row. Call it inside the same transaction as the change it
 * records, so the audit trail and the change commit or roll back together.
 */
export async function audit(
  db: Db | Tx,
  clock: Clock,
  entry: AuditEntry,
  id: string,
): Promise<void> {
  await db.insert(auditLog).values({
    id,
    actorId: entry.actorId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    before: entry.before === undefined ? null : JSON.stringify(entry.before),
    after: entry.after === undefined ? null : JSON.stringify(entry.after),
    at: clock.now(),
  });
}
