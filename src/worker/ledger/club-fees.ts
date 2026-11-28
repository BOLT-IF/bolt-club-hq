import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { clubFee, clubSettings, ledgerEntry, member, term } from "../../../db/schema";
import {
  formatClubYear,
  inferClubYearFromDate,
  resolveTermMembershipPeriod,
  type TermSeason,
} from "../../domain/club-fee";
import { itemize, type LedgerRow } from "../../domain/ledger";
import { audit } from "../core/audit";
import type { Clock } from "../core/clock";
import { contextMiddleware } from "../core/context";
import type { Tx } from "../core/db/client";
import { idempotent as createIdempotent } from "../core/idempotency";
import { requireActor, requireGuard } from "../core/permissions";
import type { CurrentMember } from "../core/ports";
import { DEFAULT_SETTINGS } from "../settings/model";
import type { AppEnv } from "../types";
import { createLedgerService } from "./service";

const NOTE_MAX = 500;
const MAX_BATCH = 500;

export type ClubFeeStatus =
  | "paid_fall"
  | "paid_fall_external"
  | "charged_fall_unpaid"
  | "paid_spring"
  | "charged_spring_unpaid"
  | "exempt"
  | "not_charged";

export type EnsureClubFeeResult =
  | {
      charged: true;
      clubFeeId: string;
      ledgerEntryId: string;
      amountSek: number;
    }
  | {
      charged: false;
      skippedReason: "already_covered" | "zero_fee" | "member_not_found" | "member_not_active";
    };

async function loadClubFeeSettings(tx: Tx): Promise<{ fallSek: number; springSek: number }> {
  const [row] = await tx
    .select({
      fall: clubSettings.clubFeeFallSek,
      spring: clubSettings.clubFeeSpringSek,
    })
    .from(clubSettings)
    .limit(1);
  return {
    fallSek: row?.fall ?? DEFAULT_SETTINGS.clubFeeFallSek,
    springSek: row?.spring ?? DEFAULT_SETTINGS.clubFeeSpringSek,
  };
}

/**
 * Loads `clubFee` rows for `(memberId, clubYear)` and returns both all rows and the subset
 * that are currently active (non-reversed, or reversed via `"waiver"`).
 */
async function loadMemberYearClubFees(tx: Tx, memberId: string, clubYear: number) {
  const rows = await tx
    .select()
    .from(clubFee)
    .where(and(eq(clubFee.memberId, memberId), eq(clubFee.clubYear, clubYear)))
    .orderBy(asc(clubFee.createdAt), asc(clubFee.id));

  const entryIds = rows.flatMap((r) => (r.ledgerEntryId ? [r.ledgerEntryId] : []));
  const reversedReasonByEntryId = new Map<string, string>();
  if (entryIds.length > 0) {
    const reversals = await tx
      .select({ reversesEntryId: ledgerEntry.reversesEntryId, reason: ledgerEntry.reason })
      .from(ledgerEntry)
      .where(inArray(ledgerEntry.reversesEntryId, entryIds));
    for (const rev of reversals) {
      if (rev.reversesEntryId) reversedReasonByEntryId.set(rev.reversesEntryId, rev.reason);
    }
  }

  const active = rows.filter((r) => {
    if (r.kind !== "charged" || r.ledgerEntryId === null) return true;
    const revReason = reversedReasonByEntryId.get(r.ledgerEntryId);
    return revReason === undefined || revReason === "waiver";
  });
  return { all: rows, active };
}

/**
 * Ensures a member has been covered for the given `clubYear` (Fall/Spring membership fee).
 * Serialises on the `member` row lock (`FOR UPDATE`). Any active (non-reversed) `club_fee`
 * row for `(memberId, clubYear)` — whether charged in Fall, charged in Spring, marked
 * `external_fall_paid`, or `exempt` — skips charging.
 */
export async function ensureClubFeeForMember(
  tx: Tx,
  clock: Clock,
  input: {
    memberId: string;
    clubYear: number;
    season: TermSeason;
    actor?: CurrentMember;
  },
): Promise<EnsureClubFeeResult> {
  const [m] = await tx
    .select({ id: member.id, status: member.status })
    .from(member)
    .where(eq(member.id, input.memberId))
    .for("update");
  if (!m) return { charged: false, skippedReason: "member_not_found" };
  if (m.status === "erased" || m.status === "pending") {
    return { charged: false, skippedReason: "member_not_active" };
  }

  const existing = await loadMemberYearClubFees(tx, input.memberId, input.clubYear);
  if (existing.active.length > 0) {
    return { charged: false, skippedReason: "already_covered" };
  }

  const fees = await loadClubFeeSettings(tx);
  const amountSek = input.season === "fall" ? fees.fallSek : fees.springSek;
  if (amountSek <= 0) {
    return { charged: false, skippedReason: "zero_fee" };
  }

  const version = existing.all.length > 0 ? `:v${String(existing.all.length + 1)}` : "";
  const idempotencyKey = `club-fee:${String(input.clubYear)}:${input.memberId}${version}`;
  const seasonLabel = input.season === "fall" ? "Fall" : "Spring";
  const note = `Club fee — ${seasonLabel} ${formatClubYear(input.clubYear)}`;

  const chargeResult = await createLedgerService({ db: tx, clock }).charge({
    memberId: input.memberId,
    amountSek,
    reason: "club_fee",
    note,
    idempotencyKey,
  });

  const clubFeeId = `cf_${crypto.randomUUID()}`;
  await tx.insert(clubFee).values({
    id: clubFeeId,
    memberId: input.memberId,
    clubYear: input.clubYear,
    season: input.season,
    kind: "charged",
    amountSek,
    ledgerEntryId: chargeResult.entryId,
    note,
    recordedBy: input.actor?.id ?? null,
    createdAt: clock.now(),
  });

  return {
    charged: true,
    clubFeeId,
    ledgerEntryId: chargeResult.entryId,
    amountSek,
  };
}

const actorOf = requireActor;
const context = contextMiddleware();
const admin = requireGuard("admin");
const idempotent = createIdempotent((c) => `POST /api/v1${c.req.path}`);

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await c.req.json().catch(() => null);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function parseClubYearValue(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 2000 && v <= 2100 ? v : null;
}

function parseMemberIdsValue(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BATCH) return null;
  if (!v.every((id) => typeof id === "string" && id.trim().length > 0)) return null;
  return [...new Set((v as string[]).map((id) => id.trim()))];
}

const clubFeeRoutes = new Hono<AppEnv>();

clubFeeRoutes.get("/admin/club-fees", context, admin, async (c) => {
  const { db, clock } = c.var;
  const currentYear = inferClubYearFromDate(clock.now()).clubYear;
  const rawYear = c.req.query("clubYear");
  let clubYear = currentYear;
  if (rawYear !== undefined) {
    if (!/^\d{4}$/.test(rawYear)) return c.json({ error: "invalid_club_year" }, 400);
    const parsed = parseClubYearValue(Number(rawYear));
    if (parsed === null) return c.json({ error: "invalid_club_year" }, 400);
    clubYear = parsed;
  }

  const [settingsRow, memberRows, feeRows, allFeeYears, termRows] = await Promise.all([
    db
      .select({
        fall: clubSettings.clubFeeFallSek,
        spring: clubSettings.clubFeeSpringSek,
      })
      .from(clubSettings)
      .limit(1),
    db
      .select({
        id: member.id,
        displayName: member.displayName,
        paymentRef: member.paymentRef,
        status: member.status,
      })
      .from(member)
      .where(ne(member.status, "erased"))
      .orderBy(asc(member.displayName), asc(member.id)),
    db
      .select()
      .from(clubFee)
      .where(eq(clubFee.clubYear, clubYear))
      .orderBy(asc(clubFee.createdAt), asc(clubFee.id)),
    db.selectDistinct({ clubYear: clubFee.clubYear }).from(clubFee),
    db
      .select({
        startsOn: term.startsOn,
        season: term.season,
        clubYear: term.clubYear,
      })
      .from(term),
  ]);

  const fallFeeSek = settingsRow[0]?.fall ?? DEFAULT_SETTINGS.clubFeeFallSek;
  const springFeeSek = settingsRow[0]?.spring ?? DEFAULT_SETTINGS.clubFeeSpringSek;

  const yearSet = new Set<number>([currentYear, clubYear]);
  for (const row of allFeeYears) yearSet.add(row.clubYear);
  for (const t of termRows) yearSet.add(resolveTermMembershipPeriod(t).clubYear);
  const availableYears = [...yearSet].sort((a, b) => b - a);

  const memberIds = memberRows.map((m) => m.id);
  const ledgerRows =
    memberIds.length === 0
      ? []
      : await db
          .select()
          .from(ledgerEntry)
          .where(inArray(ledgerEntry.memberId, memberIds))
          .orderBy(asc(ledgerEntry.createdAt), asc(ledgerEntry.id));

  const ledgerByMember = new Map<string, LedgerRow[]>();
  for (const row of ledgerRows) {
    const list = ledgerByMember.get(row.memberId) ?? [];
    list.push({
      id: row.id,
      kind: row.kind,
      amountSek: row.amountSek,
      reason: row.reason,
      createdAt: row.createdAt.getTime(),
      reversesEntryId: row.reversesEntryId,
    });
    ledgerByMember.set(row.memberId, list);
  }

  const feesByMember = new Map<string, Array<typeof clubFee.$inferSelect>>();
  for (const f of feeRows) {
    const list = feesByMember.get(f.memberId) ?? [];
    list.push(f);
    feesByMember.set(f.memberId, list);
  }

  interface ClubFeeMemberRow {
    memberId: string;
    displayName: string;
    paymentRef: string;
    memberStatus: (typeof memberRows)[number]["status"];
    status: ClubFeeStatus;
    season: TermSeason | null;
    kind: (typeof clubFee.$inferSelect)["kind"] | null;
    paidInFall: boolean;
    ledgerEntryId: string | null;
    clubFeeId: string | null;
    amountSek: number;
    oweAmountSek: number;
    note: string;
    recordedAt: string | null;
  }

  const members = memberRows.map((m): ClubFeeMemberRow => {
    const memberLedger = ledgerByMember.get(m.id) ?? [];
    const itemized = itemize(memberLedger);
    const itemById = new Map(itemized.items.map((item) => [item.entry.id, item]));
    const waivedEntryIds = new Set(
      memberLedger.flatMap((row) =>
        row.kind === "reversal" && row.reason === "waiver" && row.reversesEntryId
          ? [row.reversesEntryId]
          : [],
      ),
    );
    const activeFees = (feesByMember.get(m.id) ?? []).filter(
      (f) =>
        f.kind !== "charged" ||
        f.ledgerEntryId === null ||
        itemById.get(f.ledgerEntryId)?.status !== "reversed" ||
        waivedEntryIds.has(f.ledgerEntryId),
    );
    const active = activeFees.at(-1) ?? null;

    if (!active) {
      return {
        memberId: m.id,
        displayName: m.displayName,
        paymentRef: m.paymentRef,
        memberStatus: m.status,
        status: "not_charged",
        season: null,
        kind: null,
        paidInFall: false,
        ledgerEntryId: null,
        clubFeeId: null,
        amountSek: 0,
        oweAmountSek: 0,
        note: "",
        recordedAt: null,
      };
    }

    if (active.kind === "external_fall_paid") {
      return {
        memberId: m.id,
        displayName: m.displayName,
        paymentRef: m.paymentRef,
        memberStatus: m.status,
        status: "paid_fall_external",
        season: active.season,
        kind: active.kind,
        paidInFall: true,
        ledgerEntryId: null,
        clubFeeId: active.id,
        amountSek: 0,
        oweAmountSek: 0,
        note: active.note,
        recordedAt: active.createdAt.toISOString(),
      };
    }

    if (
      active.kind === "exempt" ||
      (active.ledgerEntryId !== null && waivedEntryIds.has(active.ledgerEntryId))
    ) {
      return {
        memberId: m.id,
        displayName: m.displayName,
        paymentRef: m.paymentRef,
        memberStatus: m.status,
        status: "exempt",
        season: active.season,
        kind: active.kind,
        paidInFall: false,
        ledgerEntryId: active.ledgerEntryId,
        clubFeeId: active.id,
        amountSek: 0,
        oweAmountSek: 0,
        note: active.note,
        recordedAt: active.createdAt.toISOString(),
      };
    }

    const item = active.ledgerEntryId ? itemById.get(active.ledgerEntryId) : undefined;
    const isPaid = item ? item.status === "paid" : false;
    const oweAmountSek = item ? item.outstandingSek : active.amountSek;
    const status: ClubFeeStatus =
      active.season === "fall"
        ? isPaid
          ? "paid_fall"
          : "charged_fall_unpaid"
        : isPaid
          ? "paid_spring"
          : "charged_spring_unpaid";

    return {
      memberId: m.id,
      displayName: m.displayName,
      paymentRef: m.paymentRef,
      memberStatus: m.status,
      status,
      season: active.season,
      kind: active.kind,
      paidInFall: status === "paid_fall",
      ledgerEntryId: active.ledgerEntryId,
      clubFeeId: active.id,
      amountSek: active.amountSek,
      oweAmountSek,
      note: active.note,
      recordedAt: active.createdAt.toISOString(),
    };
  });

  const summary = {
    totalMembers: members.length,
    paidFallCount: members.filter((m) => m.paidInFall).length,
    paidFallInAppCount: members.filter((m) => m.status === "paid_fall").length,
    paidFallExternalCount: members.filter((m) => m.status === "paid_fall_external").length,
    owesFallCount: members.filter((m) => m.status === "charged_fall_unpaid").length,
    springCount: members.filter(
      (m) => m.status === "paid_spring" || m.status === "charged_spring_unpaid",
    ).length,
    paidSpringCount: members.filter((m) => m.status === "paid_spring").length,
    owesSpringCount: members.filter((m) => m.status === "charged_spring_unpaid").length,
    exemptCount: members.filter((m) => m.status === "exempt").length,
    notChargedCount: members.filter((m) => m.status === "not_charged").length,
  };

  return c.json({
    clubYear,
    label: formatClubYear(clubYear),
    fallFeeSek,
    springFeeSek,
    availableYears,
    summary,
    members,
  });
});

clubFeeRoutes.post("/admin/club-fees/charge", context, admin, idempotent, async (c) => {
  const input = await jsonBody(c);
  if (!input) return c.json({ error: "invalid_body" }, 400);

  const clubYear = parseClubYearValue(input.clubYear);
  const season = input.season === "fall" || input.season === "spring" ? input.season : null;
  if (clubYear === null || season === null) {
    return c.json({ error: "invalid_body" }, 400);
  }

  let requestedIds: string[] | null = null;
  if (input.memberIds !== undefined) {
    requestedIds = parseMemberIdsValue(input.memberIds);
    if (!requestedIds) return c.json({ error: "invalid_body" }, 400);
  }

  const actor = actorOf(c);
  const { db, clock } = c.var;

  const result = await db.transaction(async (tx) => {
    const targetIds =
      requestedIds ??
      (
        await tx
          .select({ id: member.id })
          .from(member)
          .where(eq(member.status, "active"))
          .orderBy(asc(member.id))
      ).map((m) => m.id);

    const chargedMemberIds: string[] = [];
    let skippedCount = 0;

    for (const memberId of targetIds) {
      const outcome = await ensureClubFeeForMember(tx, clock, {
        memberId,
        clubYear,
        season,
        actor,
      });
      if (outcome.charged) {
        chargedMemberIds.push(memberId);
        await audit(
          tx,
          clock,
          {
            actorId: actor.id,
            action: "club_fee.charge",
            entity: "club_fee",
            entityId: outcome.clubFeeId,
            after: {
              memberId,
              clubYear,
              season,
              amountSek: outcome.amountSek,
              ledgerEntryId: outcome.ledgerEntryId,
            },
          },
          crypto.randomUUID(),
        );
      } else {
        skippedCount += 1;
      }
    }

    return {
      chargedCount: chargedMemberIds.length,
      skippedCount,
      chargedMemberIds,
    };
  });

  return c.json(result);
});

clubFeeRoutes.post("/admin/club-fees/mark-external-fall", context, admin, idempotent, async (c) => {
  const input = await jsonBody(c);
  if (!input) return c.json({ error: "invalid_body" }, 400);

  const clubYear = parseClubYearValue(input.clubYear);
  const memberIds = parseMemberIdsValue(input.memberIds);
  if (clubYear === null || !memberIds) {
    return c.json({ error: "invalid_body" }, 400);
  }

  if (
    input.note !== undefined &&
    (typeof input.note !== "string" || input.note.length > NOTE_MAX)
  ) {
    return c.json({ error: "invalid_body" }, 400);
  }
  const noteText =
    typeof input.note === "string" && input.note.trim().length > 0
      ? input.note.trim()
      : "Paid Fall club fee outside app";

  const actor = actorOf(c);
  const { db, clock } = c.var;

  const result = await db.transaction(async (tx) => {
    let markedCount = 0;
    let skippedCount = 0;

    for (const memberId of memberIds) {
      const [m] = await tx
        .select({ id: member.id, status: member.status })
        .from(member)
        .where(eq(member.id, memberId))
        .for("update");
      if (!m || m.status === "erased") {
        skippedCount += 1;
        continue;
      }

      const existing = await loadMemberYearClubFees(tx, memberId, clubYear);
      if (existing.active.length > 0) {
        skippedCount += 1;
        continue;
      }

      const clubFeeId = `cf_${crypto.randomUUID()}`;
      const row = {
        id: clubFeeId,
        memberId,
        clubYear,
        season: "fall" as const,
        kind: "external_fall_paid" as const,
        amountSek: 0,
        ledgerEntryId: null,
        note: noteText,
        recordedBy: actor.id,
        createdAt: clock.now(),
      };
      await tx.insert(clubFee).values(row);
      await audit(
        tx,
        clock,
        {
          actorId: actor.id,
          action: "club_fee.mark_external_fall",
          entity: "club_fee",
          entityId: clubFeeId,
          after: {
            memberId,
            clubYear,
            season: "fall",
            kind: "external_fall_paid",
            note: noteText,
          },
        },
        crypto.randomUUID(),
      );
      markedCount += 1;
    }

    return { markedCount, skippedCount };
  });

  return c.json(result);
});

clubFeeRoutes.post("/admin/club-fees/:id/clear", context, admin, idempotent, async (c) => {
  const id = c.req.param("id");
  const actor = actorOf(c);
  const { db, clock } = c.var;

  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(clubFee).where(eq(clubFee.id, id)).for("update");
    if (!row) return { ok: false as const, status: 404 as const, error: "not_found" };
    if (row.ledgerEntryId !== null) {
      return { ok: false as const, status: 409 as const, error: "reverse_in_ledger" };
    }
    await tx.delete(clubFee).where(eq(clubFee.id, id));
    await audit(
      tx,
      clock,
      {
        actorId: actor.id,
        action: "club_fee.clear",
        entity: "club_fee",
        entityId: id,
        before: row,
      },
      crypto.randomUUID(),
    );
    return { ok: true as const };
  });

  return outcome.ok
    ? c.json({ cleared: true, id })
    : c.json({ error: outcome.error }, outcome.status);
});

export default clubFeeRoutes;
