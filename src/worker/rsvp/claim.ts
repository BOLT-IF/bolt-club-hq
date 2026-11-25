import { and, asc, eq, inArray, isNull, notExists } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { alias } from "drizzle-orm/pg-core";

import { event, guest, ledgerEntry, rsvp } from "../../../db/schema";
import { claimOffer, type Candidate, type Roster } from "../../domain/allocation";
import type { Clock } from "../core/clock";
import { contextMiddleware } from "../core/context";
import type { Db, Tx } from "../core/db/client";
import { publishEvent } from "../core/events";
import { idempotent } from "../core/idempotency";
import { requireActor, requireGuard } from "../core/permissions";
import { createLedgerService } from "../ledger/service";
import { createNotifyPort } from "../notifications/notify";
import type { AppEnv } from "../types";
import { closeDueEvents } from "./close";
import type { EventRow, GuestRow, RsvpRow, RsvpStatus, RsvpView } from "./model";

const CLAIM_PATH = "/events/:id/claim";
const ACTIVE_STATUSES = ["requested", "confirmed", "waitlisted", "offered"] as const;
const isActive = (status: RsvpStatus) => status !== "cancelled" && status !== "late_cancelled";

const actorId = (c: Context<AppEnv>) => requireActor(c).id;

function parseClaimBody(body: unknown): { guestId?: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "guestId")) return null;
  const guestId = (body as { guestId?: unknown }).guestId;
  if (guestId === undefined) return {};
  if (typeof guestId !== "string" || guestId.trim() === "") return null;
  return { guestId: guestId.trim() };
}

function toView(row: RsvpRow, guests: readonly GuestRow[]): RsvpView {
  return {
    id: row.id,
    status: row.status,
    tier: row.tier,
    guests: isActive(row.status)
      ? guests
          .filter((g) => isActive(g.status))
          .map((g) => ({ id: g.id, name: g.name, status: g.status }))
      : [],
  };
}

async function guestsOf(tx: Tx, rsvpId: string): Promise<GuestRow[]> {
  return tx
    .select()
    .from(guest)
    .where(eq(guest.rsvpId, rsvpId))
    .orderBy(asc(guest.requestedAt), asc(guest.id));
}

async function loadRoster(tx: Tx, e: EventRow) {
  const members = await tx
    .select()
    .from(rsvp)
    .where(and(eq(rsvp.eventId, e.id), inArray(rsvp.status, [...ACTIVE_STATUSES])))
    .orderBy(asc(rsvp.requestedAt), asc(rsvp.id));

  const rsvpIds = members.map((m) => m.id);
  const guests: GuestRow[] =
    rsvpIds.length === 0
      ? []
      : await tx
          .select()
          .from(guest)
          .where(and(inArray(guest.rsvpId, rsvpIds), inArray(guest.status, [...ACTIVE_STATUSES])))
          .orderBy(asc(guest.requestedAt), asc(guest.id));

  const confirmed: Candidate[] = [];
  const waitlist: Candidate[] = [];

  for (const m of members) {
    const candidate: Candidate = {
      kind: "member",
      id: m.id,
      tier: e.kind === "series" && m.tier === 1 ? 1 : 2,
      requestedAt: m.requestedAt.getTime(),
    };
    if (m.status === "confirmed") confirmed.push(candidate);
    else waitlist.push(candidate);
  }

  for (const g of guests) {
    const candidate: Candidate = {
      kind: "guest",
      id: g.id,
      hostId: g.rsvpId,
      tier: 3,
      requestedAt: g.requestedAt.getTime(),
    };
    if (g.status === "confirmed") confirmed.push(candidate);
    else waitlist.push(candidate);
  }

  return {
    roster: { capacity: e.capacity, confirmed, waitlist } satisfies Roster,
    rsvpIds,
  };
}

async function chargeClaimed(
  tx: Tx,
  clock: Clock,
  e: EventRow,
  memberId: string,
  tier: number,
  guestId: string | null,
  keySuffix: string,
): Promise<void> {
  if (e.kind === "member_oneoff" || e.adhocFee <= 0) return;
  if (!guestId && e.kind === "series" && tier === 1) return;

  const ledger = createLedgerService({ db: tx, clock });
  await ledger.charge({
    memberId,
    amountSek: e.adhocFee,
    reason: guestId ? "guest" : "adhoc",
    eventId: e.id,
    ...(guestId ? { guestId } : {}),
    idempotencyKey: `postclose:${e.id}:${keySuffix}`,
  });
}

async function processRefills(
  tx: Tx,
  clock: Clock,
  e: EventRow,
  confirmedCount: number,
): Promise<void> {
  const freeSpots = Math.max(0, e.capacity - confirmedCount);

  const cancelledRsvps = await tx
    .select()
    .from(rsvp)
    .where(
      and(eq(rsvp.eventId, e.id), eq(rsvp.status, "late_cancelled"), eq(rsvp.refilled, false)),
    );

  const cancelledGuests = await tx
    .select({
      guest,
      memberId: rsvp.memberId,
      hostCancelledAt: rsvp.cancelledAt,
    })
    .from(guest)
    .innerJoin(rsvp, eq(guest.rsvpId, rsvp.id))
    .where(
      and(eq(rsvp.eventId, e.id), eq(guest.status, "late_cancelled"), eq(guest.refilled, false)),
    );

  type RefillTarget =
    | { kind: "member"; id: string; memberId: string; at: number }
    | { kind: "guest"; id: string; memberId: string; at: number };

  const targets: RefillTarget[] = [
    ...cancelledRsvps.map((r) => ({
      kind: "member" as const,
      id: r.id,
      memberId: r.memberId,
      at: (r.cancelledAt ?? r.requestedAt).getTime(),
    })),
    ...cancelledGuests.map(({ guest: g, memberId, hostCancelledAt }) => ({
      kind: "guest" as const,
      id: g.id,
      memberId,
      at: (hostCancelledAt ?? g.requestedAt).getTime(),
    })),
  ].sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    if (a.kind !== b.kind) return a.kind === "member" ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const toRefill = Math.max(0, targets.length - freeSpots);
  if (toRefill === 0) return;

  const now = clock.now();
  const ledger = createLedgerService({ db: tx, clock });
  const notify = createNotifyPort({ db: tx, clock });
  const reversal = alias(ledgerEntry, "reversal");

  for (let i = 0; i < toRefill; i++) {
    const target = targets[i];
    if (!target) break;

    if (target.kind === "member") {
      await tx.update(rsvp).set({ refilled: true }).where(eq(rsvp.id, target.id));
    } else {
      await tx.update(guest).set({ refilled: true }).where(eq(guest.id, target.id));
    }

    const [unreversedCharge] = await tx
      .select({ id: ledgerEntry.id })
      .from(ledgerEntry)
      .where(
        and(
          eq(ledgerEntry.memberId, target.memberId),
          eq(ledgerEntry.eventId, e.id),
          eq(ledgerEntry.kind, "charge"),
          target.kind === "guest"
            ? eq(ledgerEntry.guestId, target.id)
            : isNull(ledgerEntry.guestId),
          notExists(
            tx
              .select({ id: reversal.id })
              .from(reversal)
              .where(eq(reversal.reversesEntryId, ledgerEntry.id)),
          ),
        ),
      )
      .orderBy(asc(ledgerEntry.createdAt), asc(ledgerEntry.id))
      .limit(1);

    if (unreversedCharge) {
      await ledger.reverse({
        entryId: unreversedCharge.id,
        idempotencyKey: `refill:${unreversedCharge.id}`,
      });
    }

    await notify.notify({
      memberId: target.memberId,
      category: "rsvp_status",
      title: "Spot refilled",
      body: unreversedCharge
        ? `Your cancelled spot for ${e.title} was refilled and your ${String(e.adhocFee)} kr charge was reversed.`
        : `Your cancelled spot for ${e.title} was refilled.`,
      link: `/events/${e.shareSlug}`,
      idempotencyKey: `refill-notify:${e.id}:${target.kind}:${target.id}:${String(now.getTime())}`,
    });
  }
}

async function clearRemainingOffersIfFull(
  tx: Tx,
  eventId: string,
  rsvpIds: readonly string[],
): Promise<void> {
  await tx
    .update(rsvp)
    .set({ status: "waitlisted" })
    .where(and(eq(rsvp.eventId, eventId), eq(rsvp.status, "offered")));

  if (rsvpIds.length > 0) {
    await tx
      .update(guest)
      .set({ status: "waitlisted" })
      .where(and(inArray(guest.rsvpId, [...rsvpIds]), eq(guest.status, "offered")));
  }
}

export type ClaimError =
  | "not_found"
  | "event_ended"
  | "rsvp_not_closed"
  | "not_offered"
  | "no_seat"
  | "host_not_confirmed";

export type ClaimSpotResult = { ok: true; rsvp: RsvpView } | { ok: false; error: ClaimError };

/**
 * Claims an offered spot for a waitlisted member or guest (PLAN A6).
 * Serialized on the event row (`FOR UPDATE`) so concurrent claims have exactly one winner.
 */
export async function claimSpot(
  db: Db,
  clock: Clock,
  input: { eventId: string; memberId: string; guestId?: string },
): Promise<ClaimSpotResult> {
  await closeDueEvents(db, clock, { targetEventId: input.eventId });
  const now = clock.now();

  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(event).where(eq(event.id, input.eventId)).for("update");
    if (!e) return { ok: false, error: "not_found" } as const;
    if (e.status === "cancelled" || e.status === "completed" || e.endsAt <= now) {
      return { ok: false, error: "event_ended" } as const;
    }
    if (e.status !== "closed") {
      return { ok: false, error: "rsvp_not_closed" } as const;
    }

    const [row] = await tx
      .select()
      .from(rsvp)
      .where(and(eq(rsvp.eventId, e.id), eq(rsvp.memberId, input.memberId)));
    if (!row) return { ok: false, error: "not_offered" } as const;

    const { roster, rsvpIds } = await loadRoster(tx, e);

    if (input.guestId) {
      const currentGuests = await guestsOf(tx, row.id);
      const target = currentGuests.find((g) => g.id === input.guestId && isActive(g.status));
      if (!target) return { ok: false, error: "not_found" } as const;
      if (target.status !== "offered") return { ok: false, error: "not_offered" } as const;

      const decision = claimOffer({ roster, candidateId: target.id });
      if (decision.status === "rejected") {
        return { ok: false, error: decision.reason } as const;
      }

      await tx.update(guest).set({ status: "confirmed" }).where(eq(guest.id, target.id));
      await chargeClaimed(
        tx,
        clock,
        e,
        row.memberId,
        row.tier,
        target.id,
        `guest:${target.id}:${String(now.getTime())}`,
      );

      const newConfirmedCount = decision.roster.confirmed.length;
      await processRefills(tx, clock, e, newConfirmedCount);
      if (newConfirmedCount >= e.capacity) {
        await clearRemainingOffersIfFull(tx, e.id, rsvpIds);
      }

      const updatedGuests = await guestsOf(tx, row.id);
      const view = toView(row, updatedGuests);
      await publishEvent(tx, clock, {
        id: `evo_${crypto.randomUUID()}`,
        type: "rsvp_changed",
        payload: {
          eventId: e.id,
          memberId: row.memberId,
          rsvpId: row.id,
          status: row.status,
          previousStatus: row.status,
          tier: row.tier,
          guests: view.guests.length,
          reason: "promoted",
        },
      });
      return { ok: true, rsvp: view } as const;
    }

    if (row.status !== "offered") {
      return { ok: false, error: "not_offered" } as const;
    }

    const decision = claimOffer({ roster, candidateId: row.id });
    if (decision.status === "rejected") {
      return { ok: false, error: decision.reason } as const;
    }

    const [updated] = await tx
      .update(rsvp)
      .set({ status: "confirmed", confirmedAt: now })
      .where(eq(rsvp.id, row.id))
      .returning();
    if (!updated) throw new Error("claimSpot: update returned no row");

    await chargeClaimed(
      tx,
      clock,
      e,
      row.memberId,
      row.tier,
      null,
      `${row.id}:${String(now.getTime())}`,
    );

    const newConfirmedCount = decision.roster.confirmed.length;
    await processRefills(tx, clock, e, newConfirmedCount);
    if (newConfirmedCount >= e.capacity) {
      await clearRemainingOffersIfFull(tx, e.id, rsvpIds);
    }

    const view = toView(updated, await guestsOf(tx, updated.id));
    await publishEvent(tx, clock, {
      id: `evo_${crypto.randomUUID()}`,
      type: "rsvp_changed",
      payload: {
        eventId: e.id,
        memberId: updated.memberId,
        rsvpId: updated.id,
        status: updated.status,
        previousStatus: "offered",
        tier: updated.tier,
        guests: view.guests.length,
        reason: "promoted",
      },
    });

    return { ok: true, rsvp: view } as const;
  });
}

export default new Hono<AppEnv>()
  .use(CLAIM_PATH, contextMiddleware())
  .post(CLAIM_PATH, requireGuard("member"), idempotent(`POST /api/v1${CLAIM_PATH}`), async (c) => {
    const parsed = parseClaimBody(await c.req.json().catch(() => ({})));
    if (!parsed) return c.json({ error: "invalid_body" }, 400);

    const result = await claimSpot(c.var.db, c.var.clock, {
      eventId: c.req.param("id"),
      memberId: actorId(c),
      ...(parsed.guestId ? { guestId: parsed.guestId } : {}),
    });

    if (result.ok) return c.json({ rsvp: result.rsvp });
    if (result.error === "not_found") return c.json({ error: "not_found" }, 404);
    return c.json({ error: result.error }, 409);
  });
