import { and, asc, eq, inArray, isNull, notExists } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { alias } from "drizzle-orm/pg-core";

import { clubSettings, event, guest, ledgerEntry, rsvp } from "../../../db/schema";
import { promote, type Candidate, type Roster } from "../../domain/allocation";
import type { Clock } from "../core/clock";
import { contextMiddleware } from "../core/context";
import type { Db, Tx } from "../core/db/client";
import { publishEvent } from "../core/events";
import { idempotent } from "../core/idempotency";
import { requireActor, requireGuard } from "../core/permissions";
import type { PrepaidPort } from "../core/ports";
import { canAccessEvent } from "../events/audience";
import { rsvpTier } from "../events/oneoff-rules";
import { createLedgerService } from "../ledger/service";
import { createNotifyPort } from "../notifications/notify";
import type { AppEnv } from "../types";
import { closeDueEvents } from "./close";
import { rsvpDeps } from "./deps";
import { isInMaterialChangeWindow, reverseMemberEventCharges } from "./eventchange";
import {
  DEFAULT_GUEST_NAME,
  MAX_GUEST_NAME,
  type EventRow,
  type GuestRow,
  type RsvpRow,
  type RsvpStatus,
  type RsvpView,
} from "./model";

const LATE_PATH = "/events/:id/rsvp/late";
const CANCEL_PATH = "/events/:id/rsvp/late-cancel";
const STATUS_PATH = "/events/:id/rsvp/postclose";
const DEFAULT_CUTOFF_MIN = 180;

const ACTIVE_STATUSES = ["requested", "confirmed", "waitlisted", "offered"] as const;
const isActive = (status: RsvpStatus) =>
  status !== "cancelled" && status !== "late_cancelled" && status !== "declined";

const actorId = (c: Context<AppEnv>) => requireActor(c).id;

function parseGuests(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "guests")) return null;
  const raw = (body as { guests?: unknown }).guests;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const name = item.trim();
    if (name.length > MAX_GUEST_NAME) return null;
    names.push(name === "" ? DEFAULT_GUEST_NAME : name);
  }
  return names;
}

function parseCancelBody(body: unknown): { guestId?: string } | null {
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

async function guestsOf(db: Db | Tx, rsvpId: string): Promise<GuestRow[]> {
  return db
    .select()
    .from(guest)
    .where(eq(guest.rsvpId, rsvpId))
    .orderBy(asc(guest.requestedAt), asc(guest.id));
}

async function findRsvp(db: Db | Tx, eventId: string, memberId: string) {
  const [row] = await db
    .select()
    .from(rsvp)
    .where(and(eq(rsvp.eventId, eventId), eq(rsvp.memberId, memberId)));
  return row;
}

async function emitRsvpChanged(
  tx: Tx,
  clock: Clock,
  row: RsvpRow,
  previousStatus: RsvpStatus | null,
  guests: number,
  reason: "rsvp" | "cancel" | "promoted",
): Promise<void> {
  await publishEvent(tx, clock, {
    id: `evo_${crypto.randomUUID()}`,
    type: "rsvp_changed",
    payload: {
      eventId: row.eventId,
      memberId: row.memberId,
      rsvpId: row.id,
      status: row.status,
      previousStatus,
      tier: row.tier,
      guests,
      reason,
    },
  });
}

async function getCutoffMinutes(tx: Tx): Promise<number> {
  const [settings] = await tx
    .select({ cutoff: clubSettings.autoPromoteCutoffMin })
    .from(clubSettings)
    .where(eq(clubSettings.id, 1));
  return settings?.cutoff ?? DEFAULT_CUTOFF_MIN;
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
    memberById: new Map(members.map((m) => [m.id, m])),
    guestById: new Map(guests.map((g) => [g.id, g])),
  };
}

async function findUnreversedCharge(
  tx: Tx,
  eventId: string,
  memberId: string,
  guestId: string | null,
): Promise<{ id: string } | undefined> {
  const reversal = alias(ledgerEntry, "reversal");
  const [row] = await tx
    .select({ id: ledgerEntry.id })
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.memberId, memberId),
        eq(ledgerEntry.eventId, eventId),
        eq(ledgerEntry.kind, "charge"),
        guestId ? eq(ledgerEntry.guestId, guestId) : isNull(ledgerEntry.guestId),
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
  return row;
}

async function chargeConfirmedCandidate(
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
  // Avoid double-charging when re-confirming an RSVP that was late_cancelled without being refilled.
  if (await findUnreversedCharge(tx, e.id, memberId, guestId)) return;

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

async function processRefills(tx: Tx, clock: Clock, e: EventRow): Promise<void> {
  const { roster } = await loadRoster(tx, e);
  const freeSpots = Math.max(0, e.capacity - roster.confirmed.length);

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

  for (let i = 0; i < toRefill; i++) {
    const target = targets[i];
    if (!target) break;

    if (target.kind === "member") {
      await tx.update(rsvp).set({ refilled: true }).where(eq(rsvp.id, target.id));
    } else {
      await tx.update(guest).set({ refilled: true }).where(eq(guest.id, target.id));
    }

    const unreversedCharge = await findUnreversedCharge(
      tx,
      e.id,
      target.memberId,
      target.kind === "guest" ? target.id : null,
    );

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

async function runPromotionAndRefill(
  tx: Tx,
  clock: Clock,
  e: EventRow,
  actorRsvpId?: string,
): Promise<void> {
  const now = clock.now();
  const cutoffMinutes = await getCutoffMinutes(tx);
  const { roster, memberById, guestById } = await loadRoster(tx, e);

  const result = promote({
    mode: e.allocationMode,
    roster,
    now: now.getTime(),
    startsAt: e.startsAt.getTime(),
    cutoffMinutes,
  });

  const notify = createNotifyPort({ db: tx, clock });

  if (result.phase === "auto") {
    for (const p of result.promoted) {
      if (p.kind === "member") {
        const row = memberById.get(p.id);
        if (!row) continue;
        const [updated] = await tx
          .update(rsvp)
          .set({ status: "confirmed", confirmedAt: now })
          .where(eq(rsvp.id, row.id))
          .returning();
        if (!updated) continue;

        await chargeConfirmedCandidate(
          tx,
          clock,
          e,
          row.memberId,
          row.tier,
          null,
          `${row.id}:${String(now.getTime())}`,
        );

        if (row.id !== actorRsvpId) {
          const count = (await guestsOf(tx, row.id)).filter((g) => isActive(g.status)).length;
          await emitRsvpChanged(tx, clock, updated, row.status, count, "promoted");
          await notify.notify({
            memberId: row.memberId,
            category: "rsvp_status",
            title: "You're in",
            body: `A spot opened up for ${e.title} and you've been confirmed.`,
            link: `/events/${e.shareSlug}`,
            idempotencyKey: `promote-notify:${e.id}:${row.id}:${String(now.getTime())}`,
          });
        }
      } else {
        const g = guestById.get(p.id);
        if (!g) continue;
        const host = memberById.get(g.rsvpId);
        if (!host) continue;
        await tx.update(guest).set({ status: "confirmed" }).where(eq(guest.id, g.id));
        await chargeConfirmedCandidate(
          tx,
          clock,
          e,
          host.memberId,
          host.tier,
          g.id,
          `guest:${g.id}:${String(now.getTime())}`,
        );
        if (host.id !== actorRsvpId) {
          await notify.notify({
            memberId: host.memberId,
            category: "rsvp_status",
            title: "Guest confirmed",
            body: `Your guest ${g.name} for ${e.title} has been confirmed from the waitlist.`,
            link: `/events/${e.shareSlug}`,
            idempotencyKey: `promote-notify:${e.id}:guest:${g.id}:${String(now.getTime())}`,
          });
        }
      }
    }

    await processRefills(tx, clock, e);
    return;
  }

  // Phase "offer": mark eligible waitlisted candidates as "offered" and notify them.
  for (const candidate of result.offeredTo) {
    if (candidate.kind === "member") {
      const row = memberById.get(candidate.id);
      if (!row || row.status === "offered") continue;
      await tx.update(rsvp).set({ status: "offered" }).where(eq(rsvp.id, row.id));
      await notify.notify({
        memberId: row.memberId,
        category: "rsvp_status",
        title: "Spot available",
        body: `A spot opened up for ${e.title}. Tap to claim it.`,
        link: `/events/${e.shareSlug}`,
        idempotencyKey: `offer-notify:${e.id}:${row.id}:${String(now.getTime())}`,
      });
    } else {
      const g = guestById.get(candidate.id);
      if (!g || g.status === "offered") continue;
      const host = memberById.get(g.rsvpId);
      if (!host) continue;
      await tx.update(guest).set({ status: "offered" }).where(eq(guest.id, g.id));
      await notify.notify({
        memberId: host.memberId,
        category: "rsvp_status",
        title: "Spot available for guest",
        body: `A spot opened up for your guest ${g.name} at ${e.title}. Tap to claim it.`,
        link: `/events/${e.shareSlug}`,
        idempotencyKey: `offer-notify:${e.id}:guest:${g.id}:${String(now.getTime())}`,
      });
    }
  }
}

type PostCloseError =
  "not_found" | "rsvp_not_closed" | "event_ended" | "guest_limit" | "no_active_rsvp";

type PostCloseResult =
  { ok: true; rsvp: RsvpView } | { ok: false; error: PostCloseError; max?: number };

export async function putLateRsvp(
  db: Db,
  clock: Clock,
  prepaid: PrepaidPort,
  input: { eventId: string; memberId: string; guests: string[] },
): Promise<PostCloseResult> {
  await closeDueEvents(db, clock, { targetEventId: input.eventId });
  const now = clock.now();

  const [peek] = await db.select().from(event).where(eq(event.id, input.eventId));
  if (!peek) return { ok: false, error: "not_found" };
  const isPrepaid =
    peek.kind === "series"
      ? await prepaid.isPrepaid({ memberId: input.memberId, eventId: input.eventId })
      : false;
  const tier = rsvpTier(peek, isPrepaid);

  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(event).where(eq(event.id, input.eventId)).for("update");
    if (!e) return { ok: false, error: "not_found" } as const;
    if (e.status === "cancelled" || e.status === "completed" || e.endsAt <= now) {
      return { ok: false, error: "event_ended" } as const;
    }
    if (e.status !== "closed") {
      return { ok: false, error: "rsvp_not_closed" } as const;
    }
    if (input.guests.length > e.maxGuestsPerMember) {
      return { ok: false, error: "guest_limit", max: e.maxGuestsPerMember } as const;
    }

    const { roster: initialRoster } = await loadRoster(tx, e);
    const existing = await findRsvp(tx, e.id, input.memberId);
    const reopening = !existing || !isActive(existing.status);
    const previousStatus = existing?.status ?? null;
    const before = existing ? toView(existing, await guestsOf(tx, existing.id)) : null;

    // If joining into an open spot when the waitlist is empty (even past cutoff), confirm immediately.
    const canImmediateConfirm =
      reopening &&
      initialRoster.waitlist.length === 0 &&
      initialRoster.confirmed.length < e.capacity;

    let row: RsvpRow;
    if (!existing) {
      const [created] = await tx
        .insert(rsvp)
        .values({
          id: `rsv_${crypto.randomUUID()}`,
          eventId: e.id,
          memberId: input.memberId,
          status: canImmediateConfirm ? "confirmed" : "waitlisted",
          tier,
          requestedAt: now,
          confirmedAt: canImmediateConfirm ? now : null,
        })
        .returning();
      if (!created) throw new Error("putLateRsvp: insert returned no row");
      row = created;
    } else if (reopening) {
      const [updated] = await tx
        .update(rsvp)
        .set({
          status: canImmediateConfirm ? "confirmed" : "waitlisted",
          tier,
          requestedAt: now,
          confirmedAt: canImmediateConfirm ? now : null,
          cancelledAt: null,
          refilled: false,
        })
        .where(eq(rsvp.id, existing.id))
        .returning();
      if (!updated) throw new Error("putLateRsvp: update returned no row");
      row = updated;
    } else {
      row = existing;
    }

    if (canImmediateConfirm) {
      await chargeConfirmedCandidate(
        tx,
        clock,
        e,
        row.memberId,
        row.tier,
        null,
        `${row.id}:${String(now.getTime())}`,
      );
    }

    // Guests: keep active ones in order (name edits are free), cancel/late_cancel extras, add new as tier 3 waitlisted.
    const active = reopening ? [] : (await guestsOf(tx, row.id)).filter((g) => isActive(g.status));
    for (const [i, g] of active.entries()) {
      const name = input.guests[i];
      if (name === undefined) {
        const nextStatus: RsvpStatus = g.status === "confirmed" ? "late_cancelled" : "cancelled";
        await tx.update(guest).set({ status: nextStatus }).where(eq(guest.id, g.id));
      } else if (name !== g.name) {
        await tx.update(guest).set({ name }).where(eq(guest.id, g.id));
      }
    }

    const added = input.guests.slice(active.length);
    if (added.length > 0) {
      await tx.insert(guest).values(
        added.map((name, i) => ({
          id: `gst_${String(active.length + i).padStart(2, "0")}_${crypto.randomUUID()}`,
          rsvpId: row.id,
          name,
          status: "waitlisted" as const,
          tier: 3,
          requestedAt: now,
        })),
      );
    }

    await runPromotionAndRefill(tx, clock, e, row.id);
    row = (await findRsvp(tx, e.id, input.memberId)) ?? row;

    const after = toView(row, await guestsOf(tx, row.id));
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await emitRsvpChanged(tx, clock, row, previousStatus, after.guests.length, "rsvp");
    }
    return { ok: true, rsvp: after } as const;
  });
}

export async function lateCancelRsvp(
  db: Db,
  clock: Clock,
  input: { eventId: string; memberId: string; guestId?: string },
): Promise<PostCloseResult> {
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

    const row = await findRsvp(tx, e.id, input.memberId);
    if (!row || !isActive(row.status)) {
      return { ok: false, error: "no_active_rsvp" } as const;
    }

    const currentGuests = await guestsOf(tx, row.id);
    const freeWindow = isInMaterialChangeWindow(e, now);

    if (input.guestId) {
      const target = currentGuests.find((g) => g.id === input.guestId && isActive(g.status));
      if (!target) return { ok: false, error: "not_found" } as const;
      const wasConfirmed = target.status === "confirmed";
      await tx
        .update(guest)
        .set({ status: wasConfirmed && !freeWindow ? "late_cancelled" : "cancelled" })
        .where(eq(guest.id, target.id));

      if (wasConfirmed) {
        if (freeWindow) {
          await reverseMemberEventCharges(tx, clock, {
            eventId: e.id,
            memberId: input.memberId,
            guestId: target.id,
            keyPrefix: "free-cancel",
          });
        }
        await runPromotionAndRefill(tx, clock, e, row.id);
      }
      const updatedGuests = await guestsOf(tx, row.id);
      const after = toView(row, updatedGuests);
      await emitRsvpChanged(tx, clock, row, row.status, after.guests.length, "rsvp");
      return { ok: true, rsvp: after } as const;
    }

    // Host cancel cascades to all active guests.
    const hostWasConfirmed = row.status === "confirmed";
    const [cancelled] = await tx
      .update(rsvp)
      .set({
        status: hostWasConfirmed && !freeWindow ? "late_cancelled" : "cancelled",
        cancelledAt: now,
      })
      .where(eq(rsvp.id, row.id))
      .returning();
    if (!cancelled) throw new Error("lateCancelRsvp: update returned no row");

    let freedSpot = hostWasConfirmed;
    for (const g of currentGuests) {
      if (!isActive(g.status)) continue;
      if (g.status === "confirmed") freedSpot = true;
      await tx
        .update(guest)
        .set({ status: g.status === "confirmed" && !freeWindow ? "late_cancelled" : "cancelled" })
        .where(eq(guest.id, g.id));
    }

    if (freeWindow) {
      await reverseMemberEventCharges(tx, clock, {
        eventId: e.id,
        memberId: input.memberId,
        keyPrefix: "free-cancel",
      });
    }

    if (freedSpot) {
      await runPromotionAndRefill(tx, clock, e, cancelled.id);
    }

    await emitRsvpChanged(tx, clock, cancelled, row.status, 0, "cancel");
    return { ok: true, rsvp: toView(cancelled, []) } as const;
  });
}

function reply(c: Context<AppEnv>, result: PostCloseResult) {
  if (result.ok) return c.json({ rsvp: result.rsvp });
  if (result.error === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.error === "guest_limit") return c.json({ error: "guest_limit", max: result.max }, 400);
  return c.json({ error: result.error }, 409);
}

export default new Hono<AppEnv>()
  .use(STATUS_PATH, contextMiddleware())
  .use(LATE_PATH, contextMiddleware())
  .use(CANCEL_PATH, contextMiddleware())
  .get(STATUS_PATH, requireGuard("member"), async (c) => {
    const eventId = c.req.param("id");
    await closeDueEvents(c.var.db, c.var.clock, { targetEventId: eventId });
    const [e] = await c.var.db.select().from(event).where(eq(event.id, eventId));
    if (!e) return c.json({ error: "not_found" }, 404);
    if (!(await canAccessEvent(c.var.db, requireActor(c), e))) {
      return c.json({ error: "not_eligible" }, 403);
    }

    const now = c.var.clock.now();
    const row = await findRsvp(c.var.db, eventId, actorId(c));
    const view = row ? toView(row, await guestsOf(c.var.db, row.id)) : null;

    const activeRsvps = await c.var.db
      .select({ id: rsvp.id, status: rsvp.status })
      .from(rsvp)
      .where(and(eq(rsvp.eventId, e.id), inArray(rsvp.status, [...ACTIVE_STATUSES])));
    const rsvpIds = activeRsvps.map((r) => r.id);
    const activeGuests =
      rsvpIds.length === 0
        ? []
        : await c.var.db
            .select({ id: guest.id, status: guest.status })
            .from(guest)
            .where(
              and(inArray(guest.rsvpId, rsvpIds), inArray(guest.status, [...ACTIVE_STATUSES])),
            );

    const confirmedCount =
      activeRsvps.filter((r) => r.status === "confirmed").length +
      activeGuests.filter((g) => g.status === "confirmed").length;
    const waitlistCount =
      activeRsvps.filter((r) => r.status !== "confirmed").length +
      activeGuests.filter((g) => g.status !== "confirmed").length;
    const [settings] = await c.var.db
      .select({ cutoff: clubSettings.autoPromoteCutoffMin })
      .from(clubSettings)
      .where(eq(clubSettings.id, 1));
    const cutoffMin = settings?.cutoff ?? DEFAULT_CUTOFF_MIN;
    const isPastCutoff = now.getTime() >= e.startsAt.getTime() - cutoffMin * 60_000;

    return c.json({
      rsvp: view,
      freeSpots: Math.max(0, e.capacity - confirmedCount),
      waitlistCount,
      isPastCutoff,
    });
  })
  .put(LATE_PATH, requireGuard("member"), idempotent(`PUT /api/v1${LATE_PATH}`), async (c) => {
    const guests = parseGuests(await c.req.json().catch(() => ({})));
    if (!guests) return c.json({ error: "invalid_body" }, 400);
    const eventId = c.req.param("id");
    const [e] = await c.var.db.select().from(event).where(eq(event.id, eventId));
    if (e && !(await canAccessEvent(c.var.db, requireActor(c), e))) {
      return c.json({ error: "not_eligible" }, 403);
    }
    const result = await putLateRsvp(c.var.db, c.var.clock, rsvpDeps().prepaid(c.var.db), {
      eventId,
      memberId: actorId(c),
      guests,
    });
    return reply(c, result);
  })
  .post(
    CANCEL_PATH,
    requireGuard("member"),
    idempotent(`POST /api/v1${CANCEL_PATH}`),
    async (c) => {
      const parsed = parseCancelBody(await c.req.json().catch(() => ({})));
      if (!parsed) return c.json({ error: "invalid_body" }, 400);
      const result = await lateCancelRsvp(c.var.db, c.var.clock, {
        eventId: c.req.param("id"),
        memberId: actorId(c),
        ...(parsed.guestId ? { guestId: parsed.guestId } : {}),
      });
      return reply(c, result);
    },
  );
