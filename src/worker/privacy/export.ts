import { and, asc, eq, or } from "drizzle-orm";

import {
  auditLog,
  clubFee,
  eventEligibleMember,
  guest,
  joinRequest,
  ledgerEntry,
  member,
  notification,
  notificationPref,
  notificationSendLog,
  pass,
  paymentClaim,
  pollVote,
  pushSubscription,
  rsvp,
  seriesCaptain,
  seriesDiscountEligible,
} from "../../../db/schema";
import type { Clock } from "../core/clock";
import type { Db } from "../core/db/client";

function parseJsonOrRaw(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Exports all personal and membership data held for `memberId` across every PII table
 * in `db/schema/` (PLAN §16, GDPR Art. 15). Never includes other members' data, admin
 * actor references (`grantedBy`, `decidedBy`, `createdBy`), or Web Push cryptographic `keys`.
 */
export async function exportMemberData(db: Db, clock: Clock, memberId: string) {
  const [m] = await db.select().from(member).where(eq(member.id, memberId));
  if (!m) return null;

  const [
    joinRequests,
    seriesCaptains,
    seriesDiscountEligibles,
    eventEligibilities,
    passes,
    rsvps,
    guests,
    ledgerEntries,
    clubFees,
    paymentClaims,
    notifications,
    pushSubscriptions,
    notificationPrefs,
    notificationSendLogs,
    pollVotes,
    auditLogs,
  ] = await Promise.all([
    db
      .select({
        id: joinRequest.id,
        memberId: joinRequest.memberId,
        via: joinRequest.via,
        sourceId: joinRequest.sourceId,
        createdAt: joinRequest.createdAt,
      })
      .from(joinRequest)
      .where(eq(joinRequest.memberId, memberId))
      .orderBy(asc(joinRequest.createdAt), asc(joinRequest.id)),

    db
      .select({
        seriesId: seriesCaptain.seriesId,
        memberId: seriesCaptain.memberId,
      })
      .from(seriesCaptain)
      .where(eq(seriesCaptain.memberId, memberId))
      .orderBy(asc(seriesCaptain.seriesId)),

    db
      .select({
        seriesId: seriesDiscountEligible.seriesId,
        memberId: seriesDiscountEligible.memberId,
      })
      .from(seriesDiscountEligible)
      .where(eq(seriesDiscountEligible.memberId, memberId))
      .orderBy(asc(seriesDiscountEligible.seriesId)),

    db
      .select({
        eventId: eventEligibleMember.eventId,
        memberId: eventEligibleMember.memberId,
      })
      .from(eventEligibleMember)
      .where(eq(eventEligibleMember.memberId, memberId))
      .orderBy(asc(eventEligibleMember.eventId)),

    db
      .select({
        id: pass.id,
        memberId: pass.memberId,
        seriesId: pass.seriesId,
        priceCharged: pass.priceCharged,
        eventsCovered: pass.eventsCovered,
        status: pass.status,
        purchasedAt: pass.purchasedAt,
        revokedAt: pass.revokedAt,
      })
      .from(pass)
      .where(eq(pass.memberId, memberId))
      .orderBy(asc(pass.purchasedAt), asc(pass.id)),

    db
      .select({
        id: rsvp.id,
        eventId: rsvp.eventId,
        memberId: rsvp.memberId,
        status: rsvp.status,
        tier: rsvp.tier,
        requestedAt: rsvp.requestedAt,
        confirmedAt: rsvp.confirmedAt,
        cancelledAt: rsvp.cancelledAt,
        refilled: rsvp.refilled,
        attendance: rsvp.attendance,
      })
      .from(rsvp)
      .where(eq(rsvp.memberId, memberId))
      .orderBy(asc(rsvp.requestedAt), asc(rsvp.id)),

    db
      .select({
        id: guest.id,
        rsvpId: guest.rsvpId,
        name: guest.name,
        status: guest.status,
        tier: guest.tier,
        requestedAt: guest.requestedAt,
        cancelledAt: guest.cancelledAt,
        refilled: guest.refilled,
        attendance: guest.attendance,
      })
      .from(guest)
      .innerJoin(rsvp, eq(guest.rsvpId, rsvp.id))
      .where(eq(rsvp.memberId, memberId))
      .orderBy(asc(guest.requestedAt), asc(guest.id)),

    db
      .select({
        id: ledgerEntry.id,
        memberId: ledgerEntry.memberId,
        kind: ledgerEntry.kind,
        amountSek: ledgerEntry.amountSek,
        reason: ledgerEntry.reason,
        eventId: ledgerEntry.eventId,
        passId: ledgerEntry.passId,
        guestId: ledgerEntry.guestId,
        paymentClaimId: ledgerEntry.paymentClaimId,
        reversesEntryId: ledgerEntry.reversesEntryId,
        note: ledgerEntry.note,
        createdAt: ledgerEntry.createdAt,
        idempotencyKey: ledgerEntry.idempotencyKey,
        exportedAt: ledgerEntry.exportedAt,
      })
      .from(ledgerEntry)
      .where(eq(ledgerEntry.memberId, memberId))
      .orderBy(asc(ledgerEntry.createdAt), asc(ledgerEntry.id)),

    db
      .select({
        id: clubFee.id,
        memberId: clubFee.memberId,
        clubYear: clubFee.clubYear,
        season: clubFee.season,
        kind: clubFee.kind,
        amountSek: clubFee.amountSek,
        ledgerEntryId: clubFee.ledgerEntryId,
        note: clubFee.note,
        createdAt: clubFee.createdAt,
      })
      .from(clubFee)
      .where(eq(clubFee.memberId, memberId))
      .orderBy(asc(clubFee.createdAt), asc(clubFee.id)),

    db
      .select({
        id: paymentClaim.id,
        memberId: paymentClaim.memberId,
        amountSek: paymentClaim.amountSek,
        paidOn: paymentClaim.paidOn,
        note: paymentClaim.note,
        status: paymentClaim.status,
        decidedAt: paymentClaim.decidedAt,
        rejectReason: paymentClaim.rejectReason,
      })
      .from(paymentClaim)
      .where(eq(paymentClaim.memberId, memberId))
      .orderBy(asc(paymentClaim.paidOn), asc(paymentClaim.id)),

    db
      .select({
        id: notification.id,
        memberId: notification.memberId,
        category: notification.category,
        title: notification.title,
        body: notification.body,
        link: notification.link,
        createdAt: notification.createdAt,
        readAt: notification.readAt,
        idempotencyKey: notification.idempotencyKey,
      })
      .from(notification)
      .where(eq(notification.memberId, memberId))
      .orderBy(asc(notification.createdAt), asc(notification.id)),

    db
      .select({
        id: pushSubscription.id,
        memberId: pushSubscription.memberId,
        endpoint: pushSubscription.endpoint,
        userAgent: pushSubscription.userAgent,
        createdAt: pushSubscription.createdAt,
        lastSuccessAt: pushSubscription.lastSuccessAt,
        failures: pushSubscription.failures,
      })
      .from(pushSubscription)
      .where(eq(pushSubscription.memberId, memberId))
      .orderBy(asc(pushSubscription.createdAt), asc(pushSubscription.id)),

    db
      .select({
        memberId: notificationPref.memberId,
        category: notificationPref.category,
        muted: notificationPref.muted,
      })
      .from(notificationPref)
      .where(eq(notificationPref.memberId, memberId))
      .orderBy(asc(notificationPref.category)),

    db
      .select({
        id: notificationSendLog.id,
        memberId: notificationSendLog.memberId,
        category: notificationSendLog.category,
        ruleId: notificationSendLog.ruleId,
        sentAt: notificationSendLog.sentAt,
      })
      .from(notificationSendLog)
      .where(eq(notificationSendLog.memberId, memberId))
      .orderBy(asc(notificationSendLog.sentAt), asc(notificationSendLog.id)),

    db
      .select({
        pollId: pollVote.pollId,
        optionId: pollVote.optionId,
        memberId: pollVote.memberId,
        votedAt: pollVote.votedAt,
      })
      .from(pollVote)
      .where(eq(pollVote.memberId, memberId))
      .orderBy(asc(pollVote.votedAt), asc(pollVote.pollId), asc(pollVote.optionId)),

    db
      .select()
      .from(auditLog)
      .where(
        or(
          eq(auditLog.actorId, memberId),
          and(eq(auditLog.entity, "member"), eq(auditLog.entityId, memberId)),
        ),
      )
      .orderBy(asc(auditLog.at), asc(auditLog.id)),
  ]);

  return {
    exportedAt: clock.now().toISOString(),
    member: {
      id: m.id,
      clerkUserId: m.clerkUserId,
      displayName: m.displayName,
      email: m.email,
      rosterName: m.rosterName,
      role: m.role,
      status: m.status,
      paymentRef: m.paymentRef,
      joinedAt: m.joinedAt,
      leftAt: m.leftAt,
      globalMute: m.globalMute,
    },
    joinRequests,
    seriesCaptains,
    seriesDiscountEligibles,
    eventEligibilities,
    passes,
    rsvps,
    guests,
    ledgerEntries,
    clubFees,
    paymentClaims,
    notifications,
    pushSubscriptions,
    notificationPrefs,
    notificationSendLogs,
    pollVotes,
    auditLogs: auditLogs.map((row) => ({
      id: row.id,
      actorId: row.actorId === memberId ? row.actorId : null,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      before: parseJsonOrRaw(row.before),
      after: parseJsonOrRaw(row.after),
      at: row.at,
    })),
  };
}
