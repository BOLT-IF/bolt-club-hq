import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";

import { member, seriesCaptain } from "../../../db/schema";
import type { AppEnv } from "../types";
import { systemClock, type Clock } from "./clock";
import type { Db } from "./db/client";
import type { CurrentMember, CurrentMemberPort } from "./ports";
import { testIdentityFromRequest } from "./test-identity";

/**
 * Per-request context for /api/v1 feature routes (W2 contract, DECISIONS 2026-11-24).
 * An area opts in with `new Hono<AppEnv>().use("*", contextMiddleware())`, then reads
 * `c.var.db`, `c.var.clock` and `c.var.actor` (null when signed out). The permission
 * guards read `actor`. Money and RSVP POSTs add
 * `idempotencyKeyMiddleware({ db, route, actorOf: (c) => c.var.actor!.id })` after the guard.
 */
export interface AppVariables {
  db: Db;
  clock: Clock;
  actor: CurrentMember | null;
}

export interface RequestDeps {
  /** Opens the database for one request. Production: Hyperdrive. Tests pass their test db. */
  db: (env: Cloudflare.Env) => Promise<Db>;
  /** Called once the response is built, to close what `db` opened. */
  release: (db: Db) => Promise<void>;
  clock: Clock;
  /** Returns the Clerk user id from a verified bearer token, or null. S1.1 supplies the real one. */
  authenticate: (request: Request, env: Cloudflare.Env) => Promise<string | null>;
  /** Maps a Clerk user id to a member. S1.1 replaces the default (it creates pending members). */
  currentMember: (db: Db, env: Cloudflare.Env) => CurrentMemberPort;
}

/** Default lookup: an existing member row plus the series they captain. Creates nothing. */
export function memberLookup(db: Db): CurrentMemberPort {
  return {
    async currentMember({ clerkUserId }) {
      const [row] = await db.select().from(member).where(eq(member.clerkUserId, clerkUserId));
      if (!row) return null;
      const captains = await db
        .select({ seriesId: seriesCaptain.seriesId })
        .from(seriesCaptain)
        .where(eq(seriesCaptain.memberId, row.id));
      return {
        id: row.id,
        role: row.role,
        status: row.status,
        seriesIds: captains.map((c) => c.seriesId),
      };
    },
  };
}

const defaults: RequestDeps = {
  // Dynamic import: the workers Vitest pool cannot load pg (docs/ops/db.md), and the route
  // registry imports every routes.ts eagerly, so pg must stay out of the static graph.
  db: async (env) => (await import("./db/client")).createDb(env.HYPERDRIVE.connectionString),
  // drizzle keeps the pg.Pool on $client; ending it closes the Hyperdrive socket.
  release: (db) => (db as unknown as { $client: { end(): Promise<void> } }).$client.end(),
  clock: systemClock,
  // shortcut: no bearer verification until S1.1; only the ENV=test identity header resolves.
  authenticate: () => Promise.resolve(null),
  currentMember: memberLookup,
};

let deps: RequestDeps = defaults;

/**
 * Overrides request dependencies (tests, and S1.1's production wiring). Unset fields
 * fall back to the defaults. A caller that supplies its own `db` owns it, so release
 * becomes a no-op unless given too. Call with {} to reset.
 */
export function configureRequestDeps(next: Partial<RequestDeps>): void {
  deps = {
    ...defaults,
    ...(next.db ? { release: () => Promise.resolve() } : {}),
    ...next,
  };
}

/** Sets db, clock and actor. The ENV=test identity header wins over the bearer token. */
export function contextMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { release } = deps;
    const db = await deps.db(c.env);
    c.set("db", db);
    c.set("clock", deps.clock);
    try {
      const clerkUserId =
        testIdentityFromRequest(c.env, c.req.raw) ?? (await deps.authenticate(c.req.raw, c.env));
      c.set(
        "actor",
        clerkUserId === null
          ? null
          : await deps.currentMember(db, c.env).currentMember({ clerkUserId }),
      );
      await next();
    } finally {
      await release(db);
    }
  };
}
