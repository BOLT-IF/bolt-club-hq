import { and, asc, count, desc, eq, gt, inArray, notInArray } from "drizzle-orm";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  clubSettings,
  event,
  guest,
  ledgerEntry,
  member,
  pass,
  rsvp,
  series,
  seriesDiscountEligible,
  term,
} from "../../../db/schema";
import { resolveTermMembershipPeriod } from "../../domain/club-fee";
import { itemize, type LedgerRow } from "../../domain/ledger";
import { computePassOffer, passTermsNotice } from "../../domain/proration";
import { localParts, weeklyOccurrences } from "../../domain/recurrence";
import { audit } from "../core/audit";
import type { Clock } from "../core/clock";
import type { Db, Tx } from "../core/db/client";
import { publishEvent } from "../core/events";
import type { CurrentMember } from "../core/ports";
import { ensureClubFeeForMember } from "../ledger/club-fees";
import { createLedgerService } from "../ledger/service";
import { createNotifyPort } from "../notifications/notify";
import { DEFAULT_SETTINGS } from "../settings/model";

const DAY_MS = 86_400_000;
const SALE_TERM_STATUSES = ["open_for_passes", "active"] as const;

type SeriesRow = typeof series.$inferSelect;
type TermRow = typeof term.$inferSelect;
type EventRow = typeof event.$inferSelect;
type PassRow = typeof pass.$inferSelect;

export type ServiceOut<T> =
  | { ok: true; value: T }
  | { ok: false; status: ContentfulStatusCode; body: { error: string } & Record<string, unknown> };

const ok = <T>(value: T): ServiceOut<T> => ({ ok: true, value });
const fail = (
  status: ContentfulStatusCode,
  error: string,
  extra: Record<string, unknown> = {},
): ServiceOut<never> => ({ ok: false, status, body: { error, ...extra } });

export interface PassOfferView {
  seriesId: string;
  seriesName: string;
  termId: string;
  termName: string;
  format: string;
  weekday: number;
  startTime: string;
  durationMin: number;
  location: string | null;
  passPrice: number;
  regularPassPrice: number;
  discounted: boolean;
  priceSek: number;
  remainingEvents: number;
  totalEvents: number;
  passCap: number;
  passesSold: number;
  seatsRemaining: number;
  alreadyOwned: boolean;
  termsNotice: string;
}

export interface MemberPassView {
  id: string;
  seriesId: string;
  seriesName: string;
  termName: string;
  priceCharged: number;
  eventsCovered: number;
  status: PassRow["status"];
  purchasedAt: string;
  revokedAt: string | null;
}

export interface AdminPassView {
  id: string;
  memberId: string;
  memberName: string;
  paymentRef: string;
  seriesId: string;
  seriesName: string;
  termName: string;
  priceCharged: number;
  eventsCovered: number;
  purchasedAt: string;
  chargeStatus: "unpaid" | "partly_paid" | "paid" | "none";
  unpaidSek: number;
  revocableAt: string;
  daysElapsed: number;
  revocable: boolean;
}

function isOpenForPass(e: Pick<EventRow, "status" | "rsvpCloseAt" | "endsAt">, now: Date): boolean {
  return e.status === "scheduled" && e.rsvpCloseAt > now && e.endsAt > now;
}

/**
 * Counts total planned sessions and remaining open sessions for a series at `now`.
 * Uses concrete event rows where generated and falls back to `weeklyOccurrences` for
 * dates not yet generated (e.g. when a term opens for passes before `generate-events`).
 */
function calculateOffer(
  s: SeriesRow,
  t: TermRow,
  seriesEvents: readonly EventRow[],
  now: Date,
  discountEligible = false,
) {
  const planned = weeklyOccurrences({
    startsOn: t.startsOn,
    endsOn: t.endsOn,
    weekday: s.weekday,
    startTime: s.startTime,
    durationMin: s.durationMin,
    rsvpCloseOffsetMin: s.rsvpCloseOffsetMin,
    skipDates: s.skipDates,
  });
  const plannedByDate = new Map(planned.map((o) => [o.date, o]));
  const eventsByDate = new Map(seriesEvents.map((e) => [localParts(e.startsAt).date, e]));
  const allDates = new Set([...plannedByDate.keys(), ...eventsByDate.keys()]);

  let remainingEvents = 0;
  for (const date of allDates) {
    const ev = eventsByDate.get(date);
    if (ev) {
      if (isOpenForPass(ev, now)) remainingEvents += 1;
    } else {
      const occ = plannedByDate.get(date);
      if (occ && occ.rsvpCloseAt > now && occ.endsAt > now) remainingEvents += 1;
    }
  }
  const discounted = discountEligible && s.discountedPassPrice !== null;
  const effectivePassPrice = discounted ? (s.discountedPassPrice ?? s.passPrice) : s.passPrice;
  return {
    ...computePassOffer({
      passPrice: effectivePassPrice,
      remainingEvents,
      totalEvents: allDates.size,
    }),
    effectivePassPrice,
    discounted,
  };
}

async function loadRevokeDays(q: Db | Tx): Promise<number> {
  const [row] = await q
    .select({ days: clubSettings.passUnpaidRevokeDays })
    .from(clubSettings)
    .limit(1);
  return row?.days ?? DEFAULT_SETTINGS.passUnpaidRevokeDays;
}

async function countActiveGuests(tx: Tx, rsvpId: string): Promise<number> {
  const [{ n } = { n: 0 }] = await tx
    .select({ n: count() })
    .from(guest)
    .where(
      and(eq(guest.rsvpId, rsvpId), notInArray(guest.status, ["cancelled", "late_cancelled"])),
    );
  return n;
}

/**
 * Upgrades (`pass_purchased`) or downgrades (`pass_revoked`) the member's open future
 * series RSVPs (before close) while holding event locks in id order to serialise with `putRsvp`.
 */
async function transitionOpenSeriesRsvps(
  tx: Tx,
  clock: Clock,
  input: {
    seriesId: string;
    memberId: string;
    now: Date;
    direction: "upgrade" | "downgrade";
  },
): Promise<number> {
  const openEvents = await tx
    .select()
    .from(event)
    .where(
      and(
        eq(event.seriesId, input.seriesId),
        eq(event.kind, "series"),
        eq(event.status, "scheduled"),
        gt(event.rsvpCloseAt, input.now),
        gt(event.endsAt, input.now),
      ),
    )
    .orderBy(asc(event.id))
    .for("update");

  let changed = 0;
  for (const ev of openEvents) {
    if (ev.allocationMode !== "tiered") continue;
    const [existing] = await tx
      .select()
      .from(rsvp)
      .where(and(eq(rsvp.eventId, ev.id), eq(rsvp.memberId, input.memberId)));
    if (!existing) continue;

    if (input.direction === "upgrade") {
      if (existing.status !== "requested") continue;
      const [updated] = await tx
        .update(rsvp)
        .set({ status: "confirmed", tier: 1, confirmedAt: input.now })
        .where(eq(rsvp.id, existing.id))
        .returning();
      if (!updated) continue;
      await publishEvent(tx, clock, {
        id: `evo_${crypto.randomUUID()}`,
        type: "rsvp_changed",
        payload: {
          eventId: updated.eventId,
          memberId: updated.memberId,
          rsvpId: updated.id,
          status: updated.status,
          previousStatus: existing.status,
          tier: updated.tier,
          guests: await countActiveGuests(tx, updated.id),
          reason: "pass_purchased",
        },
      });
      changed += 1;
    } else {
      if (existing.status === "cancelled" || existing.status === "late_cancelled") continue;
      if (existing.status !== "confirmed" && existing.tier !== 1) continue;
      const [updated] = await tx
        .update(rsvp)
        .set({ status: "requested", tier: 2, confirmedAt: null })
        .where(eq(rsvp.id, existing.id))
        .returning();
      if (!updated) continue;
      await publishEvent(tx, clock, {
        id: `evo_${crypto.randomUUID()}`,
        type: "rsvp_changed",
        payload: {
          eventId: updated.eventId,
          memberId: updated.memberId,
          rsvpId: updated.id,
          status: updated.status,
          previousStatus: existing.status,
          tier: updated.tier,
          guests: await countActiveGuests(tx, updated.id),
          reason: "pass_revoked",
        },
      });
      changed += 1;
    }
  }
  return changed;
}

export async function listOffersAndPasses(
  db: Db,
  memberId: string,
  clock: Clock,
): Promise<{ offers: PassOfferView[]; passes: MemberPassView[] }> {
  const now = clock.now();
  const seriesRows = await db
    .select({ series, term })
    .from(series)
    .innerJoin(term, eq(term.id, series.termId))
    .where(inArray(term.status, [...SALE_TERM_STATUSES]))
    .orderBy(asc(term.startsOn), asc(series.weekday), asc(series.startTime), asc(series.name));

  const seriesIds = seriesRows.map((r) => r.series.id);
  const events =
    seriesIds.length === 0
      ? []
      : await db.select().from(event).where(inArray(event.seriesId, seriesIds));
  const soldRows =
    seriesIds.length === 0
      ? []
      : await db
          .select({ seriesId: pass.seriesId, n: count() })
          .from(pass)
          .where(and(inArray(pass.seriesId, seriesIds), eq(pass.status, "active")))
          .groupBy(pass.seriesId);
  const myPasses = await db
    .select({
      pass,
      seriesName: series.name,
      termName: term.name,
    })
    .from(pass)
    .innerJoin(series, eq(series.id, pass.seriesId))
    .innerJoin(term, eq(term.id, series.termId))
    .where(eq(pass.memberId, memberId))
    .orderBy(desc(pass.purchasedAt), asc(pass.id));
  const eligibleRows =
    seriesIds.length === 0
      ? []
      : await db
          .select({ seriesId: seriesDiscountEligible.seriesId })
          .from(seriesDiscountEligible)
          .where(
            and(
              inArray(seriesDiscountEligible.seriesId, seriesIds),
              eq(seriesDiscountEligible.memberId, memberId),
            ),
          );
  const eligibleSeriesIds = new Set(eligibleRows.map((r) => r.seriesId));

  const eventsBySeries = new Map<string, EventRow[]>();
  for (const ev of events) {
    if (!ev.seriesId) continue;
    const list = eventsBySeries.get(ev.seriesId) ?? [];
    list.push(ev);
    eventsBySeries.set(ev.seriesId, list);
  }
  const soldBySeries = new Map(soldRows.map((r) => [r.seriesId, r.n]));
  const ownedSeriesIds = new Set(
    myPasses.filter((p) => p.pass.status === "active").map((p) => p.pass.seriesId),
  );

  const offers: PassOfferView[] = [];
  for (const { series: s, term: t } of seriesRows) {
    const calc = calculateOffer(
      s,
      t,
      eventsBySeries.get(s.id) ?? [],
      now,
      eligibleSeriesIds.has(s.id),
    );
    if (!calc.offered) continue;
    const passesSold = soldBySeries.get(s.id) ?? 0;
    offers.push({
      seriesId: s.id,
      seriesName: s.name,
      termId: t.id,
      termName: t.name,
      format: s.format,
      weekday: s.weekday,
      startTime: s.startTime,
      durationMin: s.durationMin,
      location: s.location,
      passPrice: calc.effectivePassPrice,
      regularPassPrice: s.passPrice,
      discounted: calc.discounted,
      priceSek: calc.priceSek,
      remainingEvents: calc.remainingEvents,
      totalEvents: calc.totalEvents,
      passCap: s.passCap,
      passesSold,
      seatsRemaining: Math.max(0, s.passCap - passesSold),
      alreadyOwned: ownedSeriesIds.has(s.id),
      termsNotice: passTermsNotice(calc.remainingEvents),
    });
  }

  return {
    offers,
    passes: myPasses.map(({ pass: p, seriesName, termName }) => ({
      id: p.id,
      seriesId: p.seriesId,
      seriesName,
      termName,
      priceCharged: p.priceCharged,
      eventsCovered: p.eventsCovered,
      status: p.status,
      purchasedAt: p.purchasedAt.toISOString(),
      revokedAt: p.revokedAt?.toISOString() ?? null,
    })),
  };
}

export async function issuePass(
  db: Db,
  clock: Clock,
  input: {
    seriesId: string;
    memberId: string;
    actorId: string;
    grant?: { actor: CurrentMember; customPriceSek?: number };
  },
): Promise<
  ServiceOut<{
    pass: MemberPassView & { memberId: string; grantedBy: string | null };
    upgradedRsvps: number;
  }>
> {
  const now = clock.now();
  return db.transaction(async (tx) => {
    if (input.grant) {
      const [target] = await tx
        .select({ id: member.id, status: member.status })
        .from(member)
        .where(eq(member.id, input.memberId));
      if (!target) return fail(404, "member_not_found");
      if (target.status !== "active") return fail(409, "member_not_active");
    }

    // Lock the series row so concurrent buyers for the last pass_cap seat strictly serialise.
    const [s] = await tx.select().from(series).where(eq(series.id, input.seriesId)).for("update");
    if (!s) return fail(404, "series_not_found");
    const [t] = await tx.select().from(term).where(eq(term.id, s.termId));
    if (!t) return fail(404, "series_not_found");
    if (!(SALE_TERM_STATUSES as readonly string[]).includes(t.status)) {
      return fail(409, "term_not_open");
    }

    const [existing] = await tx
      .select({ id: pass.id })
      .from(pass)
      .where(
        and(eq(pass.seriesId, s.id), eq(pass.memberId, input.memberId), eq(pass.status, "active")),
      )
      .limit(1);
    if (existing) return fail(409, "already_has_pass");

    const [{ sold } = { sold: 0 }] = await tx
      .select({ sold: count() })
      .from(pass)
      .where(and(eq(pass.seriesId, s.id), eq(pass.status, "active")));
    if (sold >= s.passCap) return fail(409, "pass_cap_reached");

    const [eligibleRow] = await tx
      .select({ memberId: seriesDiscountEligible.memberId })
      .from(seriesDiscountEligible)
      .where(
        and(
          eq(seriesDiscountEligible.seriesId, s.id),
          eq(seriesDiscountEligible.memberId, input.memberId),
        ),
      )
      .limit(1);
    const seriesEvents = await tx.select().from(event).where(eq(event.seriesId, s.id));
    const calc = calculateOffer(s, t, seriesEvents, now, eligibleRow !== undefined);
    if (!calc.offered) return fail(409, "no_events_remaining");

    const priceCharged = input.grant?.customPriceSek ?? calc.priceSek;
    const passId = `pas_${crypto.randomUUID()}`;
    const [created] = await tx
      .insert(pass)
      .values({
        id: passId,
        memberId: input.memberId,
        seriesId: s.id,
        priceCharged,
        eventsCovered: calc.remainingEvents,
        status: "active",
        purchasedAt: now,
        grantedBy: input.grant ? input.grant.actor.id : null,
      })
      .returning();
    if (!created) throw new Error("issuePass: insert returned no row");

    if (priceCharged > 0) {
      await createLedgerService({ db: tx, clock }).charge({
        memberId: input.memberId,
        amountSek: priceCharged,
        reason: "pass",
        passId,
        ...(input.grant ? { actor: input.grant.actor } : {}),
        note: `${s.name} (${String(calc.remainingEvents)} sessions)`,
        idempotencyKey: `pass:${passId}`,
      });
    }

    const period = resolveTermMembershipPeriod(t);
    await ensureClubFeeForMember(tx, clock, {
      memberId: input.memberId,
      clubYear: period.clubYear,
      season: period.season,
      ...(input.grant ? { actor: input.grant.actor } : {}),
    });

    const upgradedRsvps = await transitionOpenSeriesRsvps(tx, clock, {
      seriesId: s.id,
      memberId: input.memberId,
      now,
      direction: "upgrade",
    });

    await audit(
      tx,
      clock,
      {
        actorId: input.actorId,
        action: input.grant ? "pass.grant" : "pass.purchase",
        entity: "pass",
        entityId: passId,
        after: {
          memberId: input.memberId,
          seriesId: s.id,
          priceCharged,
          eventsCovered: calc.remainingEvents,
          upgradedRsvps,
          grantedBy: created.grantedBy,
        },
      },
      crypto.randomUUID(),
    );

    return ok({
      pass: {
        id: created.id,
        memberId: created.memberId,
        seriesId: created.seriesId,
        seriesName: s.name,
        termName: t.name,
        priceCharged: created.priceCharged,
        eventsCovered: created.eventsCovered,
        status: created.status,
        purchasedAt: created.purchasedAt.toISOString(),
        revokedAt: null,
        grantedBy: created.grantedBy,
      },
      upgradedRsvps,
    });
  });
}

export async function listAdminPasses(
  db: Db,
  clock: Clock,
): Promise<{ revokeAfterDays: number; passes: AdminPassView[] }> {
  const now = clock.now();
  const revokeAfterDays = await loadRevokeDays(db);

  const rows = await db
    .select({
      pass,
      memberName: member.displayName,
      paymentRef: member.paymentRef,
      seriesName: series.name,
      termName: term.name,
    })
    .from(pass)
    .innerJoin(member, eq(member.id, pass.memberId))
    .innerJoin(series, eq(series.id, pass.seriesId))
    .innerJoin(term, eq(term.id, series.termId))
    .where(eq(pass.status, "active"))
    .orderBy(asc(pass.purchasedAt), asc(pass.id));

  const memberIds = [...new Set(rows.map((r) => r.pass.memberId))];
  const entries =
    memberIds.length === 0
      ? []
      : await db
          .select()
          .from(ledgerEntry)
          .where(inArray(ledgerEntry.memberId, memberIds))
          .orderBy(asc(ledgerEntry.createdAt), asc(ledgerEntry.id));

  type EntryWithPass = LedgerRow & { passId: string | null };
  const byMember = new Map<string, EntryWithPass[]>();
  for (const row of entries) {
    const list = byMember.get(row.memberId) ?? [];
    list.push({
      id: row.id,
      kind: row.kind,
      amountSek: row.amountSek,
      reason: row.reason,
      createdAt: row.createdAt.getTime(),
      reversesEntryId: row.reversesEntryId,
      passId: row.passId,
    });
    byMember.set(row.memberId, list);
  }

  const itemizedByMember = new Map(
    [...byMember.entries()].map(([id, list]) => [id, itemize(list)]),
  );

  const passes: AdminPassView[] = rows.map(
    ({ pass: p, memberName, paymentRef, seriesName, termName }) => {
      const itemized = itemizedByMember.get(p.memberId);
      const chargeItem = itemized?.items.find(
        (i) => i.entry.passId === p.id && i.entry.kind === "charge" && i.entry.reason === "pass",
      );
      const unpaidSek =
        chargeItem && (chargeItem.status === "unpaid" || chargeItem.status === "partly_paid")
          ? chargeItem.outstandingSek
          : 0;
      const chargeStatus: AdminPassView["chargeStatus"] =
        !chargeItem || chargeItem.status === "reversed"
          ? "none"
          : chargeItem.status === "paid"
            ? "paid"
            : chargeItem.status === "partly_paid"
              ? "partly_paid"
              : "unpaid";

      const revocableAt = new Date(p.purchasedAt.getTime() + revokeAfterDays * DAY_MS);
      const daysElapsed = Math.max(
        0,
        Math.floor((now.getTime() - p.purchasedAt.getTime()) / DAY_MS),
      );
      const revocable = unpaidSek > 0 && now.getTime() >= revocableAt.getTime();

      return {
        id: p.id,
        memberId: p.memberId,
        memberName,
        paymentRef,
        seriesId: p.seriesId,
        seriesName,
        termName,
        priceCharged: p.priceCharged,
        eventsCovered: p.eventsCovered,
        purchasedAt: p.purchasedAt.toISOString(),
        chargeStatus,
        unpaidSek,
        revocableAt: revocableAt.toISOString(),
        daysElapsed,
        revocable,
      };
    },
  );

  return { revokeAfterDays, passes };
}

export async function revokePass(
  db: Db,
  clock: Clock,
  input: { passId: string; actor: CurrentMember; note?: string },
): Promise<
  ServiceOut<{
    pass: { id: string; status: "revoked"; revokedAt: string };
    reversalEntryId: string;
    downgradedRsvps: number;
  }>
> {
  const now = clock.now();
  const [peek] = await db
    .select({ seriesId: pass.seriesId })
    .from(pass)
    .where(eq(pass.id, input.passId));
  if (!peek) return fail(404, "pass_not_found");

  return db.transaction(async (tx) => {
    // Same lock order as issuePass: series -> pass -> open events.
    const [s] = await tx.select().from(series).where(eq(series.id, peek.seriesId)).for("update");
    const [p] = await tx.select().from(pass).where(eq(pass.id, input.passId)).for("update");
    if (!p || !s) return fail(404, "pass_not_found");
    if (p.status === "revoked") return fail(409, "pass_already_revoked");

    const revokeDays = await loadRevokeDays(tx);
    const revocableAt = new Date(p.purchasedAt.getTime() + revokeDays * DAY_MS);
    if (now.getTime() < revocableAt.getTime()) {
      return fail(409, "revoke_too_early", {
        revocableAt: revocableAt.toISOString(),
        revokeAfterDays: revokeDays,
      });
    }

    const ledger = createLedgerService({ db: tx, clock });
    const itemized = await ledger.itemize(p.memberId);
    const chargeItem = itemized.items.find(
      (i) => i.entry.passId === p.id && i.entry.kind === "charge" && i.entry.reason === "pass",
    );
    if (!chargeItem || chargeItem.outstandingSek <= 0) {
      return fail(409, "pass_already_paid");
    }

    const note = input.note?.trim() || `Pass revoked (unpaid after ${String(revokeDays)} days)`;
    const { entryId: reversalEntryId } = await ledger.reverse({
      entryId: chargeItem.entry.id,
      actor: input.actor,
      reason: "revocation",
      note,
      idempotencyKey: `pass-revoke:${p.id}`,
    });

    const [updated] = await tx
      .update(pass)
      .set({ status: "revoked", revokedAt: now })
      .where(eq(pass.id, p.id))
      .returning();
    if (!updated || !updated.revokedAt) throw new Error("revokePass: update returned no row");

    const downgradedRsvps = await transitionOpenSeriesRsvps(tx, clock, {
      seriesId: p.seriesId,
      memberId: p.memberId,
      now,
      direction: "downgrade",
    });

    await createNotifyPort({ db: tx, clock }).notify({
      memberId: p.memberId,
      category: "payment_status",
      title: "Pass revoked",
      body: `Your ${s.name} pass was revoked because it remained unpaid. Any open RSVPs were moved to requested.`,
      link: "/money/passes",
      idempotencyKey: `pass-revoke:${p.id}`,
    });

    await audit(
      tx,
      clock,
      {
        actorId: input.actor.id,
        action: "pass.revoke",
        entity: "pass",
        entityId: p.id,
        before: { status: p.status, memberId: p.memberId, seriesId: p.seriesId },
        after: { status: "revoked", revokedAt: now, reversalEntryId, downgradedRsvps },
      },
      crypto.randomUUID(),
    );

    return ok({
      pass: { id: updated.id, status: "revoked", revokedAt: updated.revokedAt.toISOString() },
      reversalEntryId,
      downgradedRsvps,
    });
  });
}
