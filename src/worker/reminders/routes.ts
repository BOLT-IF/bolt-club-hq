import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { notificationSendLog, reminderRule } from "../../../db/schema";
import { PLACEHOLDERS, validateRuleInput, type RuleInput } from "../../domain/reminders";
import { audit } from "../core/audit";
import { contextMiddleware } from "../core/context";
import { idempotent } from "../core/idempotency";
import { requireActor, requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
import { planRule, toRule } from "./service";
import "./tick";

const BASE = "/admin/reminder-rules";
const actorId = (c: Context<AppEnv>): string => requireActor(c).id;
/** A double-tapped create would make two rules and send every reminder twice. */
const idempotentCreate = idempotent(`POST /api/v1${BASE}`);

const toColumns = (input: RuleInput, updatedBy: string) => ({
  category: input.kind,
  enabled: input.enabled,
  params: input.params,
  minIntervalDays: input.minIntervalDays,
  template: input.template,
  updatedBy,
});

const parseBody = async (c: Context<AppEnv>) =>
  validateRuleInput(await c.req.json<unknown>().catch(() => undefined));

/**
 * Reminder rules CRUD and preview (S6.5a, PLAN §11.3). Admin only. The S6.5b screen uses
 * `placeholders` from the list response. Context is scoped to this area's paths, never "*".
 */
export default new Hono<AppEnv>()
  .use(BASE, contextMiddleware())
  .use(`${BASE}/*`, contextMiddleware())

  .get(BASE, requireGuard("admin"), async (c) => {
    const rows = await c.var.db.select().from(reminderRule).orderBy(reminderRule.id);
    return c.json({ items: rows.map(toRule), placeholders: PLACEHOLDERS });
  })

  .post(BASE, requireGuard("admin"), idempotentCreate, async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: "validation", fields: parsed.errors }, 400);
    const id = `rr_${crypto.randomUUID()}`;
    const row = await c.var.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(reminderRule)
        .values({ id, ...toColumns(parsed.value, actorId(c)) })
        .returning();
      await audit(
        tx,
        c.var.clock,
        {
          actorId: actorId(c),
          action: "reminder_rule.create",
          entity: "reminder_rule",
          entityId: id,
          after: parsed.value,
        },
        crypto.randomUUID(),
      );
      return created;
    });
    if (!row) throw new Error("reminder rule insert returned no row");
    return c.json(toRule(row), 201);
  })

  .put(`${BASE}/:id`, requireGuard("admin"), async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: "validation", fields: parsed.errors }, 400);
    const id = c.req.param("id");
    const row = await c.var.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(reminderRule)
        .where(eq(reminderRule.id, id))
        .for("update");
      if (!before) return null;
      const [updated] = await tx
        .update(reminderRule)
        .set(toColumns(parsed.value, actorId(c)))
        .where(eq(reminderRule.id, id))
        .returning();
      await audit(
        tx,
        c.var.clock,
        {
          actorId: actorId(c),
          action: "reminder_rule.update",
          entity: "reminder_rule",
          entityId: id,
          before: toRule(before),
          after: parsed.value,
        },
        crypto.randomUUID(),
      );
      return updated ?? null;
    });
    return row ? c.json(toRule(row)) : c.json({ error: "not_found" }, 404);
  })

  // A rule that has sent anything stays (the send log references it); disable it instead.
  .delete(`${BASE}/:id`, requireGuard("admin"), async (c) => {
    const id = c.req.param("id");
    const result = await c.var.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(reminderRule)
        .where(eq(reminderRule.id, id))
        .for("update");
      if (!before) return "not_found" as const;
      const [used] = await tx
        .select({ id: notificationSendLog.id })
        .from(notificationSendLog)
        .where(eq(notificationSendLog.ruleId, id))
        .limit(1);
      if (used) return "rule_has_sends" as const;
      await tx.delete(reminderRule).where(eq(reminderRule.id, id));
      await audit(
        tx,
        c.var.clock,
        {
          actorId: actorId(c),
          action: "reminder_rule.delete",
          entity: "reminder_rule",
          entityId: id,
          before: toRule(before),
        },
        crypto.randomUUID(),
      );
      return "deleted" as const;
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "rule_has_sends") return c.json({ error: "rule_has_sends" }, 409);
    return c.body(null, 204);
  })

  // Who the rule would remind if the scheduler ran now: the same planner as the real send.
  // A preview writes nothing, so it needs no Idempotency-Key. Disabled rules preview too.
  .post(`${BASE}/:id/preview`, requireGuard("admin"), async (c) => {
    const [row] = await c.var.db
      .select()
      .from(reminderRule)
      .where(eq(reminderRule.id, c.req.param("id")));
    if (!row) return c.json({ error: "not_found" }, 404);
    const { sends } = await planRule(c.var.db, toRule(row), c.var.clock.now());
    return c.json({
      count: sends.length,
      recipients: sends.map((s) => ({ memberId: s.memberId, displayName: s.displayName })),
      sample: sends[0] ? { title: sends[0].title, body: sends[0].body, link: sends[0].link } : null,
    });
  });
