import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";

import { idempotencyRecord } from "../../../db/schema";
import type { Db } from "./db/client";

export interface IdempotencyOptions {
  db: Db;
  /** Route label stored with the record, e.g. "POST /api/v1/ledger". */
  route: string;
  /** Resolves the acting member id from the request context. */
  actorOf: (c: Parameters<MiddlewareHandler>[0]) => string;
}

const HEADER = "Idempotency-Key";

/**
 * Requires an `Idempotency-Key` header on money and RSVP POSTs (PLAN §5.2 invariant 2).
 *
 * Claim first, then run: the request inserts an empty record for (key, actor, route)
 * with ON CONFLICT DO NOTHING. Only the request whose insert lands runs the handler,
 * so concurrent duplicates (a double-tap) can never run it twice. The others replay
 * the stored response, or get 409 while the first is still running. A handler that
 * throws or returns 5xx releases the claim so a retry can run again.
 */
export function idempotencyKeyMiddleware(options: IdempotencyOptions): MiddlewareHandler {
  return async (c, next) => {
    const key = c.req.header(HEADER);
    if (!key) {
      return c.json({ error: "idempotency_key_required", header: HEADER }, 400);
    }
    const actorId = options.actorOf(c);
    const match = and(
      eq(idempotencyRecord.key, key),
      eq(idempotencyRecord.actorId, actorId),
      eq(idempotencyRecord.route, options.route),
    );

    const claimed = await options.db
      .insert(idempotencyRecord)
      .values({ key, actorId, route: options.route })
      .onConflictDoNothing()
      .returning({ key: idempotencyRecord.key });

    if (claimed.length === 0) {
      const [existing] = await options.db.select().from(idempotencyRecord).where(match).limit(1);
      if (existing?.responseBody != null) {
        return new Response(existing.responseBody, {
          status: existing.responseStatus ?? 200,
          headers: { "Content-Type": "application/json", "Idempotent-Replayed": "true" },
        });
      }
      return c.json({ error: "idempotency_key_in_progress", header: HEADER }, 409);
    }

    const release = () => options.db.delete(idempotencyRecord).where(match);
    try {
      await next();
    } catch (error) {
      await release();
      throw error;
    }

    // Hono catches handler errors itself and sets c.error and a 500 response.
    if (c.error !== undefined || c.res.status >= 500) {
      await release();
      return;
    }

    const body = await c.res.clone().text();
    await options.db
      .update(idempotencyRecord)
      .set({ responseBody: body, responseStatus: c.res.status, responseHash: await sha256(body) })
      .where(match);
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
