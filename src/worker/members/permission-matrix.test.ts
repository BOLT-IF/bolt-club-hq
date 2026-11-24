import { describe, expect, it } from "vitest";
import { Hono, type MiddlewareHandler } from "hono";

import type { CurrentMember } from "../core/ports";
import { requireGuard, type GuardOptions, type GuardKind } from "../core/permissions";
import type { AppEnv } from "../types";

/**
 * PLAN §4 permission matrix, table-driven: four roles against the capability rows
 * the guards express. "creator" is a plain member who owns the resource.
 */
type Role = "member" | "creator" | "captain" | "admin";

const SERIES = "s1";
const actors: Record<Role, CurrentMember> = {
  member: { id: "m-plain", role: "member", status: "active", seriesIds: [] },
  creator: { id: "m-creator", role: "member", status: "active", seriesIds: [] },
  captain: { id: "m-captain", role: "member", status: "active", seriesIds: [SERIES] },
  admin: { id: "m-admin", role: "admin", status: "active", seriesIds: [] },
};

const options: GuardOptions = {
  ownerOf: () => "m-creator",
  seriesIdOf: () => SERIES,
};

const rows: Array<{ capability: string; kind: GuardKind; allowed: Record<Role, boolean> }> = [
  {
    capability: "view events, RSVP, own ledger",
    kind: "member",
    allowed: { member: true, creator: true, captain: true, admin: true },
  },
  {
    capability: "edit or cancel own one-off",
    kind: "owner-or-admin",
    allowed: { member: false, creator: true, captain: false, admin: true },
  },
  {
    capability: "edit own series, mark attendance",
    kind: "captain-of-series",
    allowed: { member: false, creator: false, captain: true, admin: true },
  },
  {
    capability: "terms, settings, roles, approvals, money admin",
    kind: "admin",
    allowed: { member: false, creator: false, captain: false, admin: true },
  },
];

function appFor(actor: CurrentMember | null, guard: MiddlewareHandler) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      c.set("actor", actor);
      await next();
    })
    .get("/x", guard, (c) => c.json({ ok: true }));
}

const env = {} as Cloudflare.Env;

describe("permission matrix (PLAN §4)", () => {
  for (const row of rows) {
    for (const role of Object.keys(actors) as Role[]) {
      it(`${row.capability}: ${role} ${row.allowed[role] ? "allowed" : "forbidden"}`, async () => {
        const res = await appFor(actors[role], requireGuard(row.kind, options)).request(
          "/x",
          {},
          env,
        );
        expect(res.status).toBe(row.allowed[role] ? 200 : 403);
      });
    }
  }

  it("signed-out requests get 401 on every kind", async () => {
    for (const row of rows) {
      const res = await appFor(null, requireGuard(row.kind, options)).request("/x", {}, env);
      expect(res.status).toBe(401);
    }
  });

  const blocked: Array<CurrentMember["status"]> = ["pending", "inactive", "erased"];
  for (const status of blocked) {
    it(`a ${status} admin never passes a guard without allowInactive`, async () => {
      const actor = { ...actors.admin, status };
      for (const row of rows) {
        const res = await appFor(actor, requireGuard(row.kind, options)).request("/x", {}, env);
        expect(res.status).toBe(403);
      }
    });
  }

  it("allowInactive lets an inactive member through (own-data routes) but not pending or erased", async () => {
    const guard = requireGuard("member", { allowInactive: true });
    const statusOf = async (status: CurrentMember["status"]) =>
      (await appFor({ ...actors.member, status }, guard).request("/x", {}, env)).status;
    expect(await statusOf("inactive")).toBe(200);
    expect(await statusOf("pending")).toBe(403);
    expect(await statusOf("erased")).toBe(403);
  });
});
