import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import { clubSettings, guest, member, rsvp } from "../../../db/schema";
import {
  buildRosterImportPayload,
  buildRosterImportUrl,
  formatRosterTextList,
  type RosterPlayerInput,
} from "../../domain/roster-link";
import { requireGuard } from "../core/permissions";
import type { AppEnv } from "../types";
import { getEventById } from "./model";
import { canManageEvent } from "./rules";

export default new Hono<AppEnv>().get(
  "/events/:id/roster-link",
  requireGuard("member"),
  async (c) => {
    const actor = c.var.actor;
    const row = await getEventById(c.var.db, c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    if (!actor || !canManageEvent(actor, row)) return c.json({ error: "forbidden" }, 403);
    if (row.status === "cancelled") return c.json({ error: "event_cancelled" }, 409);

    const [settingsRow] = await c.var.db
      .select({ rosterAppUrl: clubSettings.rosterAppUrl })
      .from(clubSettings);
    const rosterAppUrl = settingsRow?.rosterAppUrl ?? null;

    const memberRows = await c.var.db
      .select({
        id: rsvp.id,
        name: member.displayName,
        rosterName: member.rosterName,
        tier: rsvp.tier,
        confirmedAt: rsvp.confirmedAt,
        requestedAt: rsvp.requestedAt,
      })
      .from(rsvp)
      .innerJoin(member, eq(member.id, rsvp.memberId))
      .where(and(eq(rsvp.eventId, row.id), eq(rsvp.status, "confirmed")));

    const guestRows = await c.var.db
      .select({
        id: guest.id,
        name: guest.name,
        tier: guest.tier,
        requestedAt: guest.requestedAt,
      })
      .from(guest)
      .innerJoin(rsvp, eq(rsvp.id, guest.rsvpId))
      .where(and(eq(rsvp.eventId, row.id), eq(guest.status, "confirmed")));

    const inputs: RosterPlayerInput[] = [
      ...memberRows.map((m) => ({
        name: m.name,
        rosterName: m.rosterName,
        guest: false,
        tier: m.tier,
        confirmedAt: m.confirmedAt ?? m.requestedAt,
        sortId: m.id,
      })),
      ...guestRows.map((g) => ({
        name: g.name,
        guest: true,
        tier: g.tier,
        confirmedAt: g.requestedAt,
        sortId: g.id,
      })),
    ];

    const eventInput = {
      title: row.title,
      startsAt: row.startsAt,
      format: row.format,
    };
    const payload = buildRosterImportPayload(eventInput, inputs);
    const url = rosterAppUrl ? buildRosterImportUrl(rosterAppUrl, eventInput, inputs) : null;

    return c.json({
      rosterAppUrl,
      url,
      textList: formatRosterTextList(payload.players),
      players: payload.players,
    });
  },
);
