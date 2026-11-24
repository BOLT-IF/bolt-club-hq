import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { poll, pollOption, pollVote } from "../../../db/schema";
import { audit } from "../core/audit";
import { contextMiddleware } from "../core/context";
import type { CurrentMember } from "../core/ports";
import { requireGuard } from "../core/permissions";
import { createNotifyPort } from "../notifications/notify";
import type { AppEnv } from "../types";
import { activeMemberIds, getPoll, listPolls, replaceVote, toDtos, type PollRow } from "./model";
import { scheduleClosingReminder } from "./reminders";
import { isClosed, parseCreate, parsePatch, validateChoice } from "./rules";

/** The guard has run, so an actor exists; fail loudly rather than assert. */
function actorOf(c: Context<AppEnv>): CurrentMember {
  const actor = c.var.actor;
  if (!actor) throw new Error("polls: guard let a request through without an actor");
  return actor;
}

const notFound = (c: Context<AppEnv>) => c.json({ error: "not_found" }, 404);
const bad = (c: Context<AppEnv>, error: string) => c.json({ error }, 400);
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const readJson = (c: Context<AppEnv>): Promise<unknown> => c.req.json().catch(() => null);

async function one(c: Context<AppEnv>, row: PollRow) {
  const [dto] = await toDtos(c.var.db, [row], actorOf(c), c.var.clock.now());
  return dto;
}

/** Audit snapshot of a poll. Never includes votes, so anonymous polls stay anonymous here too. */
const snapshot = (row: PollRow) => ({
  question: row.question,
  multiChoice: row.multiChoice,
  anonymous: row.anonymous,
  resultsVisibility: row.resultsVisibility,
  closesAt: row.closesAt?.toISOString() ?? null,
});

// Scoped, not "*": every area is mounted at /api/v1 (DECISIONS 2026-11-24, W2 contract 2).
export default new Hono<AppEnv>()
  .use("/polls", contextMiddleware())
  .use("/polls/*", contextMiddleware())
  .get("/polls", requireGuard("member"), async (c) => {
    const rows = await listPolls(c.var.db);
    return c.json({ polls: await toDtos(c.var.db, rows, actorOf(c), c.var.clock.now()) });
  })
  .get("/polls/:id", requireGuard("member"), async (c) => {
    const row = await getPoll(c.var.db, c.req.param("id"));
    return row ? c.json({ poll: await one(c, row) }) : notFound(c);
  })
  .post("/polls", requireGuard("admin"), async (c) => {
    const actor = actorOf(c);
    const now = c.var.clock.now();
    const parsed = parseCreate(await readJson(c), now);
    if (!parsed.ok) return bad(c, parsed.error);
    const input = parsed.value;
    const id = newId("pol");

    const row = await c.var.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(poll)
        .values({
          id,
          question: input.question,
          createdBy: actor.id,
          closesAt: input.closesAt,
          multiChoice: input.multiChoice,
          anonymous: input.anonymous,
          resultsVisibility: input.resultsVisibility,
          createdAt: now,
        })
        .returning();
      if (!created) throw new Error("polls: insert returned no row");
      // Option ids sort in creation order, so the list keeps the admin's order.
      await tx.insert(pollOption).values(
        input.options.map((label, i) => ({
          id: `${id}_o${String(i).padStart(2, "0")}`,
          pollId: id,
          label,
        })),
      );
      await audit(
        tx,
        c.var.clock,
        {
          actorId: actor.id,
          action: "poll.create",
          entity: "poll",
          entityId: id,
          after: snapshot(created),
        },
        newId("aud"),
      );
      const notify = createNotifyPort({ db: tx, clock: c.var.clock });
      for (const memberId of await activeMemberIds(tx)) {
        await notify.notify({
          memberId,
          category: "polls",
          title: "New poll",
          body: input.question,
          link: `/polls/${id}`,
          idempotencyKey: `poll-created:${id}:${memberId}`,
        });
      }
      return created;
    });

    await scheduleClosingReminder(c.env.KV, row.closesAt, now);
    return c.json({ poll: await one(c, row) }, 201);
  })
  .patch("/polls/:id", requireGuard("admin"), async (c) => {
    const actor = actorOf(c);
    const now = c.var.clock.now();
    const parsed = parsePatch(await readJson(c), now);
    if (!parsed.ok) return bad(c, parsed.error);

    const row = await c.var.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(poll)
        .where(eq(poll.id, c.req.param("id")))
        .for("update");
      if (!before) return null;
      const [after] = await tx
        .update(poll)
        .set(parsed.value)
        .where(eq(poll.id, before.id))
        .returning();
      if (!after) return null;
      await audit(
        tx,
        c.var.clock,
        {
          actorId: actor.id,
          action: "poll.update",
          entity: "poll",
          entityId: before.id,
          before: snapshot(before),
          after: snapshot(after),
        },
        newId("aud"),
      );
      return after;
    });
    if (!row) return notFound(c);
    if (parsed.value.closesAt !== undefined)
      await scheduleClosingReminder(c.env.KV, row.closesAt, now);
    return c.json({ poll: await one(c, row) });
  })
  .delete("/polls/:id", requireGuard("admin"), async (c) => {
    const actor = actorOf(c);
    const deleted = await c.var.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(poll)
        .where(eq(poll.id, c.req.param("id")))
        .for("update");
      if (!row) return false;
      await tx.delete(pollVote).where(eq(pollVote.pollId, row.id));
      await tx.delete(pollOption).where(eq(pollOption.pollId, row.id));
      await tx.delete(poll).where(eq(poll.id, row.id));
      await audit(
        tx,
        c.var.clock,
        {
          actorId: actor.id,
          action: "poll.delete",
          entity: "poll",
          entityId: row.id,
          before: snapshot(row),
        },
        newId("aud"),
      );
      return true;
    });
    return deleted ? c.body(null, 204) : notFound(c);
  })
  // Replacing your own ballot is naturally idempotent, so no Idempotency-Key (not money/RSVP).
  .put("/polls/:id/vote", requireGuard("member"), async (c) => {
    const actor = actorOf(c);
    const now = c.var.clock.now();
    const body = (await readJson(c)) as { optionIds?: unknown } | null;

    const outcome = await c.var.db.transaction(async (tx) => {
      // Lock the poll so a vote and a concurrent close/delete serialise.
      const [row] = await tx
        .select()
        .from(poll)
        .where(eq(poll.id, c.req.param("id")))
        .for("update");
      if (!row) return { status: 404 as const, error: "not_found" };
      if (isClosed(row, now)) return { status: 409 as const, error: "poll_closed" };
      const options = await tx
        .select({ id: pollOption.id })
        .from(pollOption)
        .where(eq(pollOption.pollId, row.id));
      const choice = validateChoice(
        row,
        options.map((o) => o.id),
        body?.optionIds,
      );
      if (!choice.ok) return { status: 400 as const, error: choice.error };
      await replaceVote(tx, row.id, actor.id, choice.optionIds, now);
      return { status: 200 as const, row };
    });

    if (outcome.status !== 200) return c.json({ error: outcome.error }, outcome.status);
    return c.json({ poll: await one(c, outcome.row) });
  });
