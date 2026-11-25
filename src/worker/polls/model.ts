import { and, desc, eq, inArray } from "drizzle-orm";

import { member, poll, pollOption, pollVote } from "../../../db/schema";
import type { CurrentMember } from "../core/ports";
import type { Db, Tx } from "../core/db/client";
import { canSeeResults, isClosed } from "./rules";

export type PollRow = typeof poll.$inferSelect;

export async function getPoll(db: Db | Tx, id: string): Promise<PollRow | null> {
  const [row] = await db.select().from(poll).where(eq(poll.id, id));
  return row ?? null;
}

export function listPolls(db: Db): Promise<PollRow[]> {
  return db.select().from(poll).orderBy(desc(poll.createdAt), desc(poll.id));
}

/**
 * The poll as the viewer may see it. Voter identities are only ever read for a poll that
 * is not anonymous and whose results the viewer may see: an anonymous poll's query selects
 * no member column at all, so no code path can leak who voted (S9.1).
 */
export async function toDtos(db: Db | Tx, rows: PollRow[], viewer: CurrentMember, now: Date) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const options = await db
    .select()
    .from(pollOption)
    .where(inArray(pollOption.pollId, ids))
    .orderBy(pollOption.id);
  const votes = await db
    .select({ pollId: pollVote.pollId, optionId: pollVote.optionId, memberId: pollVote.memberId })
    .from(pollVote)
    .where(inArray(pollVote.pollId, ids));

  const isAdmin = viewer.role === "admin";
  const visible = new Map(
    rows.map((r) => {
      const hasVoted = votes.some((v) => v.pollId === r.id && v.memberId === viewer.id);
      return [r.id, canSeeResults(r, { isAdmin, hasVoted }, now)];
    }),
  );

  const named = rows.filter((r) => !r.anonymous && visible.get(r.id) === true).map((r) => r.id);
  const voterRows =
    named.length === 0
      ? []
      : await db
          .select({
            pollId: pollVote.pollId,
            optionId: pollVote.optionId,
            memberId: member.id,
            displayName: member.displayName,
          })
          .from(pollVote)
          .innerJoin(member, eq(member.id, pollVote.memberId))
          .where(inArray(pollVote.pollId, named))
          .orderBy(member.displayName);

  return rows.map((r) => {
    const mine = votes.filter((v) => v.pollId === r.id);
    const opts = options.filter((o) => o.pollId === r.id);
    const showResults = visible.get(r.id) === true;
    return {
      id: r.id,
      question: r.question,
      multiChoice: r.multiChoice,
      anonymous: r.anonymous,
      resultsVisibility: r.resultsVisibility,
      closesAt: r.closesAt?.toISOString() ?? null,
      closed: isClosed(r, now),
      createdAt: r.createdAt.toISOString(),
      options: opts.map((o) => ({
        id: o.id,
        label: o.label,
        imageUrl: o.imageKey ? `/media/${o.imageKey}` : null,
      })),
      myVote: mine.filter((v) => v.memberId === viewer.id).map((v) => v.optionId),
      resultsVisible: showResults,
      results: showResults
        ? {
            totalVoters: new Set(mine.map((v) => v.memberId)).size,
            options: opts.map((o) => {
              const count = mine.filter((v) => v.optionId === o.id).length;
              if (r.anonymous) return { optionId: o.id, votes: count };
              return {
                optionId: o.id,
                votes: count,
                voters: voterRows
                  .filter((v) => v.pollId === r.id && v.optionId === o.id)
                  .map((v) => ({ memberId: v.memberId, displayName: v.displayName })),
              };
            }),
          }
        : null,
    };
  });
}

/** Active members, the audience of poll notifications. */
export async function activeMemberIds(db: Db | Tx): Promise<string[]> {
  const rows = await db.select({ id: member.id }).from(member).where(eq(member.status, "active"));
  return rows.map((r) => r.id);
}

/** Replaces the member's ballot. The caller holds the poll row lock. */
export async function replaceVote(
  tx: Tx,
  pollId: string,
  memberId: string,
  optionIds: string[],
  at: Date,
): Promise<void> {
  await tx
    .delete(pollVote)
    .where(and(eq(pollVote.pollId, pollId), eq(pollVote.memberId, memberId)));
  await tx
    .insert(pollVote)
    .values(optionIds.map((optionId) => ({ pollId, optionId, memberId, votedAt: at })));
}
