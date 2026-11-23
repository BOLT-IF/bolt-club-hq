import { isNull, asc, eq } from "drizzle-orm";

import { domainEventOutbox } from "../../../db/schema";
import type { Clock } from "./clock";
import type { Db, Tx } from "./db/client";

export interface DomainEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Transactional outbox. Publish inside the same transaction as the state change:
 * the event row commits or rolls back with it. A worker drains unprocessed rows.
 */
export async function publishEvent(db: Db | Tx, clock: Clock, event: DomainEvent): Promise<void> {
  await db.insert(domainEventOutbox).values({
    id: event.id,
    type: event.type,
    payload: event.payload,
    createdAt: clock.now(),
  });
}

/** Returns up to `limit` unprocessed events, oldest first. */
export async function pendingEvents(db: Db, limit = 100) {
  return db
    .select()
    .from(domainEventOutbox)
    .where(isNull(domainEventOutbox.processedAt))
    .orderBy(asc(domainEventOutbox.createdAt))
    .limit(limit);
}

export async function markProcessed(db: Db, clock: Clock, id: string): Promise<void> {
  await db
    .update(domainEventOutbox)
    .set({ processedAt: clock.now() })
    .where(eq(domainEventOutbox.id, id));
}
