import { and, eq, inArray, or } from "drizzle-orm";

import { event, member, pass, rsvp, seriesCaptain } from "../../../db/schema";
import type { Db, Tx } from "../core/db/client";

export type Audience =
  | { kind: "all" }
  | { kind: "pass_holders"; seriesId?: string }
  | { kind: "captains"; seriesId?: string }
  /** `eventId` may be the event id or its share slug. */
  | { kind: "event_rsvps"; eventId: string };

export class AudienceError extends Error {
  constructor(readonly code: "event_not_found") {
    super(code);
    this.name = "AudienceError";
  }
}

/** Looks an event up by id or share slug. */
export async function findEvent(db: Db | Tx, ref: string) {
  const [row] = await db
    .select({ id: event.id, shareSlug: event.shareSlug })
    .from(event)
    .where(or(eq(event.id, ref), eq(event.shareSlug, ref)));
  return row ?? null;
}

const LIVE_RSVP = ["requested", "confirmed", "waitlisted", "offered"] as const;

const unique = (ids: readonly string[]): string[] => [...new Set(ids)].sort();

/**
 * Member ids a broadcast goes to (sorted, one each). Only `active` members are ever
 * included: pending, exited and erased members get nothing. Queries the tables directly.
 */
export async function resolveAudience(db: Db | Tx, audience: Audience): Promise<string[]> {
  const active = eq(member.status, "active");
  switch (audience.kind) {
    case "all": {
      const rows = await db.select({ id: member.id }).from(member).where(active);
      return unique(rows.map((r) => r.id));
    }
    case "pass_holders": {
      const rows = await db
        .select({ id: member.id })
        .from(pass)
        .innerJoin(member, eq(member.id, pass.memberId))
        .where(
          and(
            active,
            eq(pass.status, "active"),
            audience.seriesId ? eq(pass.seriesId, audience.seriesId) : undefined,
          ),
        );
      return unique(rows.map((r) => r.id));
    }
    case "captains": {
      const rows = await db
        .select({ id: member.id })
        .from(seriesCaptain)
        .innerJoin(member, eq(member.id, seriesCaptain.memberId))
        .where(
          and(
            active,
            audience.seriesId ? eq(seriesCaptain.seriesId, audience.seriesId) : undefined,
          ),
        );
      return unique(rows.map((r) => r.id));
    }
    case "event_rsvps": {
      const found = await findEvent(db, audience.eventId);
      if (!found) throw new AudienceError("event_not_found");
      const rows = await db
        .select({ id: member.id })
        .from(rsvp)
        .innerJoin(member, eq(member.id, rsvp.memberId))
        .where(and(active, eq(rsvp.eventId, found.id), inArray(rsvp.status, [...LIVE_RSVP])));
      return unique(rows.map((r) => r.id));
    }
  }
}
