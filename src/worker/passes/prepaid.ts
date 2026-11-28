import { and, eq } from "drizzle-orm";

import { event, member, pass } from "../../../db/schema";
import type { Db } from "../core/db/client";
import type { PrepaidPort } from "../core/ports";

/**
 * Production `PrepaidPort` (S5.3, PLAN §6.1, §6.7, §6.8).
 * Returns true only for series events when the member is active and holds an active pass
 * for that event's series. Revoked passes, exited members, and one-off events return false.
 */
export function createPrepaidPort(db: Db): PrepaidPort {
  return {
    async isPrepaid({ memberId, eventId, tx }) {
      const runner = tx ?? db;
      const [row] = await runner
        .select({ kind: event.kind, memberStatus: member.status })
        .from(event)
        .innerJoin(
          pass,
          and(
            eq(pass.seriesId, event.seriesId),
            eq(pass.memberId, memberId),
            eq(pass.status, "active"),
          ),
        )
        .innerJoin(member, eq(member.id, pass.memberId))
        .where(and(eq(event.id, eventId), eq(event.kind, "series")))
        .limit(1);
      return row !== undefined && row.kind === "series" && row.memberStatus === "active";
    },
  };
}
