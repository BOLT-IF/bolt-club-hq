import { and, asc, eq, inArray, like, or } from "drizzle-orm";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  auditLog,
  guest,
  idempotencyRecord,
  joinRequest,
  member,
  notification,
  notificationPref,
  outboundPush,
  paymentClaim,
  pushSubscription,
  rsvp,
  seriesCaptain,
  seriesDiscountEligible,
} from "../../../db/schema";
import { audit } from "../core/audit";
import type { Clock } from "../core/clock";
import type { Db, Tx } from "../core/db/client";
import type { CurrentMember } from "../core/ports";
import { createLedgerService } from "../ledger/service";
import { getRsvpCancel } from "../members/rsvp-cancel";
import { ClerkDeleteError, getClerkErase } from "./clerk";

type MemberRow = typeof member.$inferSelect;

export const formerMemberName = (id: string) => `Former member #${id}`;
export const erasedClerkId = (id: string) => `erased:${id}`;
export const erasedPaymentRef = (id: string) => `ERASED-${id}`;

class EraseRefused extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly body: { error: string; balanceSek?: number },
  ) {
    super(body.error);
  }
}

const erasedView = (m: Pick<MemberRow, "id" | "status" | "displayName">) => ({
  id: m.id,
  status: m.status,
  displayName: m.displayName,
});

function pseudonymizeValue(value: unknown, memberId: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => pseudonymizeValue(item, memberId));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "displayName") out[key] = formerMemberName(memberId);
      else if (key === "email" || key === "rosterName" || key === "clerkUserId") out[key] = null;
      else if (key === "paymentRef") out[key] = erasedPaymentRef(memberId);
      else if (key === "guestName") out[key] = "Guest";
      else out[key] = pseudonymizeValue(val, memberId);
    }
    return out;
  }
  return value;
}

function pseudonymizeAuditJson(
  raw: string | null,
  memberId: string,
  redactInvalid: boolean,
): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return JSON.stringify(pseudonymizeValue(parsed, memberId));
  } catch {
    return redactInvalid ? "[redacted]" : raw;
  }
}

async function lockActiveAdmins(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.role, "admin"), eq(member.status, "active")))
    .orderBy(asc(member.id))
    .for("update");
  return rows.map((r) => r.id);
}

function isLastAdmin(admins: string[], target: MemberRow): boolean {
  return (
    target.role === "admin" &&
    target.status === "active" &&
    admins.length === 1 &&
    admins[0] === target.id
  );
}

export type EraseResult =
  | {
      ok: true;
      member: { id: string; status: MemberRow["status"]; displayName: string };
    }
  | { ok: false; status: ContentfulStatusCode; body: Record<string, unknown> };

/**
 * Erases a member under GDPR (PLAN §16):
 * - Requires zero ledger balance (returns 409 otherwise; settle or waive first).
 * - Protects the last active admin (409 `last_admin`).
 * - Strips PII from `member`, deletes push subscriptions, notification prefs, captaincies,
 *   join requests, idempotency cache, and the member's own notifications; scrubs guest names
 *   to "Guest" and payment-claim notes; pseudonymizes audit JSON; keeps `ledger_entry` intact.
 * - Deletes the Clerk user via the Clerk API inside the transaction boundary so a Clerk
 *   failure rolls back the DB erasure cleanly.
 */
export async function eraseMember(
  db: Db,
  clock: Clock,
  env: Cloudflare.Env,
  input: { targetId: string; actor: CurrentMember },
): Promise<EraseResult> {
  const { targetId, actor } = input;
  const now = clock.now();

  try {
    const outcome = await db.transaction(async (tx) => {
      const admins = await lockActiveAdmins(tx);
      const [before] = await tx.select().from(member).where(eq(member.id, targetId)).for("update");
      if (!before) throw new EraseRefused(404, { error: "not_found" });
      if (before.status === "erased") {
        return { member: erasedView(before), cancelFuture: false };
      }
      if (isLastAdmin(admins, before)) throw new EraseRefused(409, { error: "last_admin" });

      const balanceSek = await createLedgerService({ db: tx, clock }).balance(targetId);
      if (balanceSek !== 0) {
        throw new EraseRefused(409, { error: "nonzero_balance", balanceSek });
      }

      const formerName = formerMemberName(targetId);
      const leftAt = before.leftAt ?? now;
      const cancelFuture = before.status === "active" || before.status === "pending";

      await tx.delete(pushSubscription).where(eq(pushSubscription.memberId, targetId));
      await tx.delete(notificationPref).where(eq(notificationPref.memberId, targetId));
      await tx.delete(seriesCaptain).where(eq(seriesCaptain.memberId, targetId));
      await tx.delete(seriesDiscountEligible).where(eq(seriesDiscountEligible.memberId, targetId));
      await tx.delete(idempotencyRecord).where(eq(idempotencyRecord.actorId, targetId));

      const memberRsvps = await tx
        .select({ id: rsvp.id })
        .from(rsvp)
        .where(eq(rsvp.memberId, targetId));
      const rsvpIds = memberRsvps.map((r) => r.id);
      if (rsvpIds.length > 0) {
        await tx.update(guest).set({ name: "Guest" }).where(inArray(guest.rsvpId, rsvpIds));
      }

      await tx.update(paymentClaim).set({ note: null }).where(eq(paymentClaim.memberId, targetId));

      const memberJoinRequests = await tx
        .select({ id: joinRequest.id })
        .from(joinRequest)
        .where(eq(joinRequest.memberId, targetId));
      const joinRequestIds = memberJoinRequests.map((jr) => jr.id);
      for (const jrId of joinRequestIds) {
        await tx
          .update(notification)
          .set({ body: `${formerName} asked to join the club.` })
          .where(like(notification.idempotencyKey, `join-request:${jrId}:%`));
      }
      if (joinRequestIds.length > 0) {
        await tx.delete(joinRequest).where(eq(joinRequest.memberId, targetId));
      }

      const memberNotifications = await tx
        .select({ id: notification.id })
        .from(notification)
        .where(eq(notification.memberId, targetId));
      const notificationIds = memberNotifications.map((n) => n.id);
      if (notificationIds.length > 0) {
        await tx.delete(outboundPush).where(inArray(outboundPush.notificationId, notificationIds));
        await tx.delete(notification).where(eq(notification.memberId, targetId));
      }

      const auditConditions = [
        and(eq(auditLog.entity, "member"), eq(auditLog.entityId, targetId)),
        eq(auditLog.actorId, targetId),
      ];
      if (joinRequestIds.length > 0) {
        auditConditions.push(
          and(eq(auditLog.entity, "join_request"), inArray(auditLog.entityId, joinRequestIds)),
        );
      }
      const relatedAudits = await tx
        .select()
        .from(auditLog)
        .where(or(...auditConditions));
      for (const row of relatedAudits) {
        const redactInvalid = row.entity === "member" && row.entityId === targetId;
        const nextBefore = pseudonymizeAuditJson(row.before, targetId, redactInvalid);
        const nextAfter = pseudonymizeAuditJson(row.after, targetId, redactInvalid);
        if (nextBefore !== row.before || nextAfter !== row.after) {
          await tx
            .update(auditLog)
            .set({ before: nextBefore, after: nextAfter })
            .where(eq(auditLog.id, row.id));
        }
      }

      const [updated] = await tx
        .update(member)
        .set({
          displayName: formerName,
          email: null,
          rosterName: null,
          clerkUserId: erasedClerkId(targetId),
          paymentRef: erasedPaymentRef(targetId),
          role: "member",
          status: "erased",
          leftAt,
          joinedAt: null,
          globalMute: false,
        })
        .where(eq(member.id, targetId))
        .returning();
      if (!updated) throw new Error("eraseMember: update returned no row");

      await audit(
        tx,
        clock,
        {
          actorId: actor.id,
          action: "member.erase",
          entity: "member",
          entityId: targetId,
          before: { status: before.status },
          after: { status: "erased", displayName: formerName },
        },
        crypto.randomUUID(),
      );

      await getClerkErase().deleteUser({ clerkUserId: before.clerkUserId, env });
      return { member: erasedView(updated), cancelFuture };
    });

    if (outcome.cancelFuture) {
      await getRsvpCancel().cancelFutureRsvps({
        db,
        clock,
        memberId: targetId,
        at: now,
        idempotencyKey: `member-erase:${targetId}:${now.toISOString()}`,
      });
    }

    return { ok: true, member: outcome.member };
  } catch (error) {
    if (error instanceof EraseRefused) {
      return { ok: false, status: error.status, body: error.body };
    }
    if (error instanceof ClerkDeleteError) {
      return { ok: false, status: 502, body: { error: "clerk_delete_failed" } };
    }
    throw error;
  }
}
