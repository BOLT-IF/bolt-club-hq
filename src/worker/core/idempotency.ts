import type { MiddlewareHandler } from "hono";

import { idempotencyRecord } from "../../../db/schema";
import type { Db } from "./db/client";
import { and, eq } from "drizzle-orm";

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
 * The first response is stored in `idempotency_record`; a repeat with the same
 * key and actor replays it without running the handler again.
 */
export function idempotencyKeyMiddleware(options: IdempotencyOptions): MiddlewareHandler {
  return async (c, next) => {
    const key = c.req.header(HEADER);
    if (!key) {
      return c.json({ error: "idempotency_key_required", header: HEADER }, 400);
    }
    const actorId = options.actorOf(c);

    const [existing] = await options.db
      .select()
      .from(idempotencyRecord)
      .where(
        and(
          eq(idempotencyRecord.key, key),
          eq(idempotencyRecord.actorId, actorId),
          eq(idempotencyRecord.route, options.route),
        ),
      )
      .limit(1);
    if (existing && existing.responseBody !== null) {
      return new Response(existing.responseBody, {
        status: existing.responseStatus ?? 200,
        headers: { "Content-Type": "application/json", "Idempotent-Replayed": "true" },
      });
    }

    await next();

    const response = c.res;
    const body = await response.clone().text();
    await options.db
      .insert(idempotencyRecord)
      .values({
        key,
        actorId,
        route: options.route,
        responseBody: body,
        responseStatus: response.status,
        responseHash: await sha256(body),
      })
      .onConflictDoNothing();
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
