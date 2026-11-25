import { eq } from "drizzle-orm";

import { series } from "../../../db/schema";
import { systemClock, type Clock } from "../core/clock";
import type { Db } from "../core/db/client";
import { getEventBySlug, nextOpenEvent, type EventRow } from "../events/model";
import type { OgEventData } from "./og";

export interface SeriesNextResult {
  readonly exists: boolean;
  readonly seriesTitle?: string;
  readonly event: OgEventData | null;
}

export interface ShareDeps {
  db: (env: Cloudflare.Env) => Promise<Db>;
  release: (db: Db) => Promise<void>;
  clock: Clock;
  findEventBySlug: (env: Cloudflare.Env, slug: string) => Promise<OgEventData | null>;
  findSeriesNextBySlug: (env: Cloudflare.Env, slug: string) => Promise<SeriesNextResult>;
}

function toOgEventData(row: EventRow): OgEventData {
  return {
    shareSlug: row.shareSlug,
    title: row.title,
    format: row.format,
    location: row.location,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status,
  };
}

const defaults: ShareDeps = {
  db: async (env) => (await import("../core/db/client")).createDb(env.HYPERDRIVE.connectionString),
  release: (db) => (db as unknown as { $client: { end(): Promise<void> } }).$client.end(),
  clock: systemClock,
  async findEventBySlug(env, slug) {
    const db = await deps.db(env);
    try {
      const row = await getEventBySlug(db, slug);
      return row ? toOgEventData(row) : null;
    } finally {
      await deps.release(db);
    }
  },
  async findSeriesNextBySlug(env, slug) {
    const db = await deps.db(env);
    try {
      const [found] = await db
        .select({ id: series.id, name: series.name })
        .from(series)
        .where(eq(series.shareSlug, slug));
      if (!found) return { exists: false, event: null };
      const next = await nextOpenEvent(db, slug, deps.clock.now());
      return {
        exists: true,
        seriesTitle: found.name,
        event: next ? toOgEventData(next) : null,
      };
    } finally {
      await deps.release(db);
    }
  },
};

let deps: ShareDeps = defaults;

/** Tests override DB lookups here; call with {} to reset. */
export function configureShareDeps(next: Partial<ShareDeps>): void {
  deps = {
    ...defaults,
    ...(next.db ? { release: () => Promise.resolve() } : {}),
    ...next,
  };
}

export function shareDeps(): ShareDeps {
  return deps;
}
