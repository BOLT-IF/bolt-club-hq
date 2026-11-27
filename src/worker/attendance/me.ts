import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { event, guest, ledgerEntry, rsvp } from "../../../db/schema";
import { contextMiddleware } from "../core/context";
import type { Db } from "../core/db/client";
import { requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
import type { MarkableAttendance, StoredAttendance } from "./model";

export interface MemberAttendanceGuest {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly tier: number;
  readonly requestedAt: string;
  readonly refilled: boolean;
  readonly attendance: StoredAttendance;
  readonly effectiveAttendance: MarkableAttendance | null;
}

export interface MemberAttendanceRsvp {
  readonly id: string;
  readonly status: string;
  readonly tier: number;
  readonly requestedAt: string;
  readonly confirmedAt: string | null;
  readonly cancelledAt: string | null;
  readonly refilled: boolean;
  readonly attendance: StoredAttendance;
  readonly effectiveAttendance: MarkableAttendance | null;
}

export interface MemberAttendanceLedgerEntry {
  readonly id: string;
  readonly kind: "charge" | "payment" | "reversal" | "adjustment";
  readonly reason: string;
  readonly amountSek: number;
  readonly note: string;
  readonly createdAt: string;
  readonly guestId: string | null;
  readonly reversesEntryId: string | null;
}

export interface MemberAttendanceItem {
  readonly eventId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly location: string | null;
  readonly shareSlug: string;
  readonly eventStatus: "scheduled" | "closed" | "cancelled" | "completed";
  readonly adhocFee: number;
  readonly kind: "series" | "member_oneoff" | "admin_oneoff";
  readonly rsvp: MemberAttendanceRsvp | null;
  readonly guests: readonly MemberAttendanceGuest[];
  readonly ledgerEntries: readonly MemberAttendanceLedgerEntry[];
  readonly netChargedSek: number;
  readonly why: string;
}

function effectiveOf(status: string, attendance: StoredAttendance): MarkableAttendance | null {
  if (status !== "confirmed") return null;
  return attendance === "unknown" ? "attended" : attendance;
}

function explainEventWhy(input: {
  eventStatus: "scheduled" | "closed" | "cancelled" | "completed";
  eventKind: "series" | "member_oneoff" | "admin_oneoff";
  adhocFee: number;
  rsvp: MemberAttendanceRsvp | null;
  ledgerEntries: readonly MemberAttendanceLedgerEntry[];
  netChargedSek: number;
}): string {
  const { eventStatus, eventKind, adhocFee, rsvp: r, ledgerEntries, netChargedSek } = input;
  if (eventStatus === "cancelled") {
    return ledgerEntries.length > 0 && netChargedSek === 0
      ? "Event cancelled — all charges reversed."
      : "Event cancelled — no charge.";
  }
  if (!r) {
    return netChargedSek !== 0
      ? `Adjusted on ledger (${String(netChargedSek)} kr).`
      : "Ledger activity recorded.";
  }
  if (r.status === "confirmed") {
    if (r.tier === 1) {
      return r.attendance === "no_show"
        ? "Covered by season pass (marked no-show, no extra fee)."
        : "Covered by season pass (0 kr event fee).";
    }
    if (adhocFee === 0 || eventKind === "member_oneoff") {
      return "Confirmed spot — free event (0 kr).";
    }
    return r.attendance === "no_show"
      ? `Confirmed spot, marked no-show — ${String(adhocFee)} kr charge stands.`
      : `Confirmed spot — ${String(adhocFee)} kr event fee.`;
  }
  if (r.status === "late_cancelled") {
    if (r.refilled) return "Late-cancelled, spot refilled — charge reversed.";
    if (adhocFee === 0 || eventKind === "member_oneoff") {
      return "Late-cancelled — free event (0 kr).";
    }
    return `Late-cancelled, spot not refilled — ${String(adhocFee)} kr charge stands.`;
  }
  if (r.status === "cancelled") {
    return ledgerEntries.some((e) => e.kind === "reversal")
      ? "Cancelled within free-cancel window — charge reversed."
      : "Cancelled in time — no charge.";
  }
  if (r.status === "declined") {
    return "Not going — no charge.";
  }
  return `Not confirmed (${r.status}) — no charge.`;
}

export async function loadMemberAttendanceHistory(
  db: Db,
  memberId: string,
): Promise<{ items: MemberAttendanceItem[] }> {
  const rsvps = await db.select().from(rsvp).where(eq(rsvp.memberId, memberId));

  const ledgerRows = await db
    .select()
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.memberId, memberId), isNotNull(ledgerEntry.eventId)));

  const eventIds = [
    ...new Set([
      ...rsvps.map((r) => r.eventId),
      ...ledgerRows.flatMap((l) => (l.eventId ? [l.eventId] : [])),
    ]),
  ];

  if (eventIds.length === 0) return { items: [] };

  const events = await db
    .select()
    .from(event)
    .where(inArray(event.id, eventIds))
    .orderBy(desc(event.startsAt), desc(event.id));

  const rsvpIds = rsvps.map((r) => r.id);
  const guestRows =
    rsvpIds.length === 0 ? [] : await db.select().from(guest).where(inArray(guest.rsvpId, rsvpIds));

  const rsvpByEvent = new Map(rsvps.map((r) => [r.eventId, r]));

  const guestsByRsvp = new Map<string, MemberAttendanceGuest[]>();
  for (const g of guestRows) {
    const list = guestsByRsvp.get(g.rsvpId) ?? [];
    list.push({
      id: g.id,
      name: g.name,
      status: g.status,
      tier: g.tier,
      requestedAt: g.requestedAt.toISOString(),
      refilled: g.refilled,
      attendance: g.attendance,
      effectiveAttendance: effectiveOf(g.status, g.attendance),
    });
    guestsByRsvp.set(g.rsvpId, list);
  }
  for (const list of guestsByRsvp.values()) {
    list.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id));
  }

  const ledgerByEvent = new Map<string, MemberAttendanceLedgerEntry[]>();
  for (const row of ledgerRows) {
    if (!row.eventId) continue;
    const list = ledgerByEvent.get(row.eventId) ?? [];
    list.push({
      id: row.id,
      kind: row.kind,
      reason: row.reason,
      amountSek: row.amountSek,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      guestId: row.guestId,
      reversesEntryId: row.reversesEntryId,
    });
    ledgerByEvent.set(row.eventId, list);
  }
  for (const list of ledgerByEvent.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  const items: MemberAttendanceItem[] = events.map((ev) => {
    const r = rsvpByEvent.get(ev.id) ?? null;
    const rsvpView: MemberAttendanceRsvp | null = r
      ? {
          id: r.id,
          status: r.status,
          tier: r.tier,
          requestedAt: r.requestedAt.toISOString(),
          confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
          cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
          refilled: r.refilled,
          attendance: r.attendance,
          effectiveAttendance: effectiveOf(r.status, r.attendance),
        }
      : null;
    const guests = r ? (guestsByRsvp.get(r.id) ?? []) : [];
    const entries = ledgerByEvent.get(ev.id) ?? [];
    const netChargedSek = entries.reduce((sum, e) => sum + e.amountSek, 0);

    return {
      eventId: ev.id,
      title: ev.title,
      startsAt: ev.startsAt.toISOString(),
      endsAt: ev.endsAt.toISOString(),
      location: ev.location,
      shareSlug: ev.shareSlug,
      eventStatus: ev.status,
      adhocFee: ev.adhocFee,
      kind: ev.kind,
      rsvp: rsvpView,
      guests,
      ledgerEntries: entries,
      netChargedSek,
      why: explainEventWhy({
        eventStatus: ev.status,
        eventKind: ev.kind,
        adhocFee: ev.adhocFee,
        rsvp: rsvpView,
        ledgerEntries: entries,
        netChargedSek,
      }),
    };
  });

  return { items };
}

function actorId(c: Context<AppEnv>): string {
  const actor = c.var.actor;
  if (!actor) throw new Error("me/attendance: route reached without an actor");
  return actor.id;
}

export const meAttendanceRoutes = new Hono<AppEnv>()
  .use("/me/attendance/*", contextMiddleware())
  .get("/me/attendance", requireGuard("member", { allowInactive: true }), async (c) => {
    const me = actorId(c);
    const asked = c.req.query("memberId");
    if (asked !== undefined && asked !== me) {
      return c.json({ error: "forbidden" }, 403);
    }
    const data = await loadMemberAttendanceHistory(c.var.db, me);
    return c.json(data);
  });
