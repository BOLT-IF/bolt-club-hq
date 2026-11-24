import { eq } from "drizzle-orm";

import { auditLog } from "../../../db/schema";
import { audit } from "../core/audit";
import type { Clock } from "../core/clock";
import type { Db, Tx } from "../core/db/client";
import { createNotifyPort, type NotifyDeps } from "../notifications/notify";
import { findEvent, resolveAudience } from "./audience";
import type { BroadcastDraft } from "./validate";

export interface SendDeps {
  db: Db | Tx;
  clock: Clock;
  /** Test seam, passed to `createNotifyPort` (default: the registered policy chain, so mute applies). */
  policies?: NotifyDeps["policies"];
}

export interface BroadcastInput extends BroadcastDraft {
  /** Stable per send; the same id twice notifies and audits once. */
  id: string;
  actorId: string;
}

export interface BroadcastResult {
  broadcastId: string;
  recipientCount: number;
}

/**
 * Sends an announcement to an audience (S6.6). One transaction: resolve the audience, notify
 * each member through `createNotifyPort` (inbox row always; the policy chain, including mute,
 * decides about the push) and write one audit row. Audited even with zero recipients.
 * Idempotent on `input.id`.
 */
export function sendBroadcast(deps: SendDeps, input: BroadcastInput): Promise<BroadcastResult> {
  const auditId = `aud_broadcast_${input.id}`;
  return deps.db.transaction(async (tx) => {
    const [done] = await tx.select().from(auditLog).where(eq(auditLog.id, auditId));
    if (done) {
      const after = JSON.parse(done.after ?? "{}") as { recipientCount?: number };
      return { broadcastId: input.id, recipientCount: after.recipientCount ?? 0 };
    }

    const memberIds = await resolveAudience(tx, input.audience);
    const link =
      input.audience.kind === "event_rsvps"
        ? `/events/${(await findEvent(tx, input.audience.eventId))?.shareSlug ?? ""}`
        : undefined;

    const notifier = createNotifyPort({
      db: tx,
      clock: deps.clock,
      ...(deps.policies ? { policies: deps.policies } : {}),
    });
    for (const memberId of memberIds) {
      await notifier.notify({
        memberId,
        category: "announcements",
        title: input.title,
        body: input.body,
        idempotencyKey: `broadcast:${input.id}:${memberId}`,
        ...(link ? { link } : {}),
      });
    }

    await audit(
      tx,
      deps.clock,
      {
        actorId: input.actorId,
        action: "broadcast.send",
        entity: "broadcast",
        entityId: input.id,
        after: {
          title: input.title,
          body: input.body,
          audience: input.audience,
          recipientCount: memberIds.length,
        },
      },
      auditId,
    );
    return { broadcastId: input.id, recipientCount: memberIds.length };
  });
}
