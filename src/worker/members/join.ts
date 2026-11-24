import { and, asc, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { event, joinRequest, member, series } from "../../../db/schema";
import { requireSignedIn } from "../auth/guard";
import { audit } from "../core/audit";
import { contextMiddleware } from "../core/context";
import type { Tx } from "../core/db/client";
import type { CurrentMember } from "../core/ports";
import { requireGuard } from "../core/permissions";
import { createNotifyPort } from "../notifications/notify";
import type { AppEnv } from "../types";
import { consumeInvite, readBody } from "./invites";

type Via = "invite" | "event_link" | "series_link";
type JoinRow = typeof joinRequest.$inferSelect;

const ownView = (r: JoinRow) => ({ id: r.id, via: r.via, createdAt: r.createdAt });

type Answer = { status: 200 | 201 | 400 | 403 | 404 | 409 | 410; body: Record<string, unknown> };
const answer = (status: Answer["status"], body: Record<string, unknown>): Answer => ({
  status,
  body,
});

function actorOf(c: Context<AppEnv>): CurrentMember {
  const actor = c.var.actor;
  if (!actor) throw new Error("actor missing: route is not behind a guard");
  return actor;
}

/** Validates the body into a source: an invite token, or an event/series share slug. */
function parseSource(input: Record<string, unknown> | null): { via: Via; key: string } | null {
  if (!input) return null;
  const { via } = input;
  const key = via === "invite" ? input.token : input.slug;
  if (via !== "invite" && via !== "event_link" && via !== "series_link") return null;
  if (typeof key !== "string" || key === "" || key.length > 64) return null;
  return { via, key };
}

async function resolveLink(tx: Tx, via: "event_link" | "series_link", slug: string) {
  if (via === "event_link") {
    const [row] = await tx.select({ id: event.id }).from(event).where(eq(event.shareSlug, slug));
    return row?.id ?? null;
  }
  const [row] = await tx.select({ id: series.id }).from(series).where(eq(series.shareSlug, slug));
  return row?.id ?? null;
}

/**
 * Files the caller's join request. One per pending member: the member row is locked, so a
 * repeat or concurrent request returns the existing one (200) and admins are notified once.
 */
async function fileRequest(c: Context<AppEnv>, source: { via: Via; key: string }) {
  const actor = actorOf(c);
  const { clock } = c.var;
  const now = clock.now();
  return c.var.db.transaction(async (tx): Promise<Answer> => {
    const [me] = await tx.select().from(member).where(eq(member.id, actor.id)).for("update");
    if (!me) return answer(404, { error: "not_found" });
    if (me.status === "erased") return answer(403, { error: "forbidden" });
    if (me.status !== "pending") return answer(409, { error: "already_member" });

    const [open] = await tx.select().from(joinRequest).where(eq(joinRequest.memberId, me.id));
    if (open) return answer(200, { request: ownView(open) });

    let sourceId: string | null;
    if (source.via === "invite") {
      const used = await consumeInvite(tx, source.key, now);
      if (!used.ok) {
        return used.error === "not_found"
          ? answer(404, { error: "invite_not_found" })
          : answer(410, { error: `invite_${used.error}` });
      }
      sourceId = used.id;
    } else {
      sourceId = await resolveLink(tx, source.via, source.key);
      if (!sourceId) return answer(404, { error: "link_not_found" });
    }

    const [created] = await tx
      .insert(joinRequest)
      .values({
        id: `jr_${crypto.randomUUID()}`,
        memberId: me.id,
        via: source.via,
        sourceId,
        createdAt: now,
      })
      .returning();
    if (!created) throw new Error("join_request insert returned no row");
    await audit(
      tx,
      clock,
      {
        actorId: me.id,
        action: "join_request.create",
        entity: "join_request",
        entityId: created.id,
        after: { via: created.via, sourceId },
      },
      crypto.randomUUID(),
    );

    const admins = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.role, "admin"), eq(member.status, "active")));
    const notify = createNotifyPort({ db: tx, clock });
    for (const admin of admins) {
      await notify.notify({
        memberId: admin.id,
        category: "admin_tasks",
        title: "New join request",
        body: `${me.displayName} asked to join the club.`,
        idempotencyKey: `join-request:${created.id}:${admin.id}`,
        link: "/admin/approvals",
      });
    }
    return answer(201, { request: ownView(created) });
  });
}

/** Admin queue: requests whose member is still pending, oldest first, with a readable source. */
async function queue(c: Context<AppEnv>) {
  const rows = await c.var.db
    .select({
      id: joinRequest.id,
      memberId: member.id,
      displayName: member.displayName,
      email: member.email,
      via: joinRequest.via,
      createdAt: joinRequest.createdAt,
      eventTitle: event.title,
      seriesName: series.name,
    })
    .from(joinRequest)
    .innerJoin(member, eq(member.id, joinRequest.memberId))
    .leftJoin(event, and(eq(joinRequest.via, "event_link"), eq(event.id, joinRequest.sourceId)))
    .leftJoin(series, and(eq(joinRequest.via, "series_link"), eq(series.id, joinRequest.sourceId)))
    .where(eq(member.status, "pending"))
    .orderBy(asc(joinRequest.createdAt), asc(joinRequest.id));
  return rows.map(({ eventTitle, seriesName, ...r }) => ({
    ...r,
    source: eventTitle ?? seriesName ?? null,
  }));
}

/** Locks the request and its member for approve/reject. */
async function lockRequest(tx: Tx, id: string) {
  const [request] = await tx.select().from(joinRequest).where(eq(joinRequest.id, id)).for("update");
  if (!request) return null;
  const [target] = await tx
    .select()
    .from(member)
    .where(eq(member.id, request.memberId))
    .for("update");
  return target ? { request, target } : null;
}

/**
 * Join requests and approval (S1.3). A pending member can file and read their own request;
 * everything else is admin only. Mounted from members/routes.ts.
 */
export const joinRoutes = new Hono<AppEnv>()
  // "/x/*" also matches "/x". Scoped, never "*" (W2 contract correction).
  .use("/join-requests/*", contextMiddleware())
  .use("/admin/join-requests", contextMiddleware())
  // Pending members pass requireSignedIn; the handler refuses erased (403) and members (409).
  .post("/join-requests", requireSignedIn(), async (c) => {
    const source = parseSource(await readBody(c));
    if (!source) return c.json({ error: "invalid_body" }, 400);
    const out = await fileRequest(c, source);
    return c.json(out.body, out.status);
  })
  // The waiting screen. Never returns the source id, so no event data leaks to pending members.
  .get("/join-requests/mine", requireSignedIn(), async (c) => {
    const actor = actorOf(c);
    const [open] = await c.var.db
      .select()
      .from(joinRequest)
      .where(eq(joinRequest.memberId, actor.id))
      .orderBy(asc(joinRequest.createdAt))
      .limit(1);
    return c.json({ status: actor.status, request: open ? ownView(open) : null });
  })
  .get("/admin/join-requests", requireGuard("admin"), async (c) =>
    c.json({ requests: await queue(c) }),
  )
  .post("/join-requests/:id/approve", requireGuard("admin"), async (c) => {
    const actor = actorOf(c);
    const { clock } = c.var;
    const out = await c.var.db.transaction(async (tx): Promise<Answer> => {
      const locked = await lockRequest(tx, c.req.param("id"));
      if (!locked) return answer(404, { error: "not_found" });
      const { target } = locked;
      if (target.status === "active") return answer(200, { memberId: target.id, status: "active" });
      if (target.status !== "pending") return answer(409, { error: "invalid_transition" });
      // joined_at is the approval time (PLAN §5.1); first sign-in leaves it unset or stale.
      const joinedAt = clock.now();
      await tx.update(member).set({ status: "active", joinedAt }).where(eq(member.id, target.id));
      await audit(
        tx,
        clock,
        {
          actorId: actor.id,
          action: "member.approve",
          entity: "member",
          entityId: target.id,
          before: { status: "pending" },
          after: { status: "active", joinedAt, joinRequestId: locked.request.id },
        },
        crypto.randomUUID(),
      );
      return answer(200, { memberId: target.id, status: "active" });
    });
    return c.json(out.body, out.status);
  })
  // Reject removes the request; the member stays pending and may ask again.
  .post("/join-requests/:id/reject", requireGuard("admin"), async (c) => {
    const actor = actorOf(c);
    const out = await c.var.db.transaction(async (tx): Promise<Answer> => {
      const locked = await lockRequest(tx, c.req.param("id"));
      if (!locked) return answer(404, { error: "not_found" });
      const { request, target } = locked;
      if (target.status !== "pending") return answer(409, { error: "invalid_transition" });
      await tx.delete(joinRequest).where(eq(joinRequest.id, request.id));
      await audit(
        tx,
        c.var.clock,
        {
          actorId: actor.id,
          action: "join_request.reject",
          entity: "member",
          entityId: target.id,
          before: { joinRequestId: request.id, via: request.via, sourceId: request.sourceId },
        },
        crypto.randomUUID(),
      );
      return answer(200, { memberId: target.id, status: "pending" });
    });
    return c.json(out.body, out.status);
  });
