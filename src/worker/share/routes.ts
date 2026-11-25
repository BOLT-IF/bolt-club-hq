import { Hono, type Context } from "hono";

import { eventOgKey, ogSnapshot } from "../events/rules";
import type { AppEnv } from "../types";
import { shareDeps } from "./deps";
import {
  formatOgDescription,
  injectOgIntoHtml,
  parseOgSnapshot,
  seriesOgKey,
  type OgEventData,
  type OgMeta,
} from "./og";

export const SHARE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://*.clerk.accounts.dev https://*.clerk.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://img.clerk.com https://*.clerk.com",
  "connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com",
  "frame-src 'self' https://*.clerk.accounts.dev https://*.clerk.com",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

async function loadSpaHtml(c: Context<AppEnv>): Promise<string | null> {
  const assets = (c.env as { ASSETS?: Fetcher } | undefined)?.ASSETS;
  if (!assets) return null;
  try {
    const res = await assets.fetch(new Request(new URL("/", c.req.url)));
    if (!res.ok) return null;
    const text = await res.text();
    return text.includes("<html") ? text : null;
  } catch {
    return null;
  }
}

async function readKvSnapshot(c: Context<AppEnv>, key: string): Promise<OgEventData | null> {
  const kv = (c.env as { KV?: KVNamespace } | undefined)?.KV;
  if (!kv) return null;
  try {
    const raw = await kv.get(key);
    return raw ? parseOgSnapshot(raw) : null;
  } catch {
    return null;
  }
}

async function writeKvSnapshot(c: Context<AppEnv>, event: OgEventData): Promise<void> {
  const kv = (c.env as { KV?: KVNamespace } | undefined)?.KV;
  if (!kv) return;
  try {
    await kv.put(eventOgKey(event.shareSlug), ogSnapshot(event));
  } catch {
    // Best-effort KV backfill on read miss.
  }
}

function htmlResponse(
  baseHtml: string | null,
  meta: OgMeta,
  status: 200 | 404,
  bodyFallback?: string,
): Response {
  const html = injectOgIntoHtml(baseHtml, meta, bodyFallback);
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": SHARE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

function eventMeta(event: OgEventData, url: string): OgMeta {
  return {
    title: `${event.title} — BOLT IF`,
    description: formatOgDescription(event),
    url,
  };
}

function genericMeta(url: string): OgMeta {
  return {
    title: "BOLT IF",
    description: "Open to view the event and RSVP.",
    url,
  };
}

/**
 * Edge HTML routes for `/e/:slug` and `/s/:slug` (mounted outside `/api/v1` in `src/worker/app.ts`).
 * Reads OG from KV, falls back to Neon, then to a generic preview; unknown slugs return 404.
 */
export function createShareServeApp(): Hono<AppEnv> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment -- chained Hono builder.
  return new Hono<AppEnv>()
    .get("/e/:slug", async (c) => {
      const slug = c.req.param("slug");
      const url = c.req.url;
      const baseHtml = await loadSpaHtml(c);

      const kvHit = await readKvSnapshot(c, eventOgKey(slug));
      if (kvHit) return htmlResponse(baseHtml, eventMeta(kvHit, url), 200);

      try {
        const dbHit = await shareDeps().findEventBySlug(c.env, slug);
        if (!dbHit) {
          return htmlResponse(
            baseHtml,
            {
              title: "Event not found — BOLT IF",
              description: "We couldn't find that event.",
              url,
            },
            404,
            "We couldn't find that event. The link may be old or mistyped.",
          );
        }
        await writeKvSnapshot(c, dbHit);
        return htmlResponse(baseHtml, eventMeta(dbHit, url), 200);
      } catch {
        return htmlResponse(baseHtml, genericMeta(url), 200);
      }
    })
    .get("/s/:slug", async (c) => {
      const slug = c.req.param("slug");
      const url = c.req.url;
      const baseHtml = await loadSpaHtml(c);

      const kvHit = await readKvSnapshot(c, seriesOgKey(slug));
      if (kvHit) return htmlResponse(baseHtml, eventMeta(kvHit, url), 200);

      try {
        const dbHit = await shareDeps().findSeriesNextBySlug(c.env, slug);
        if (!dbHit.exists) {
          return htmlResponse(
            baseHtml,
            {
              title: "Series not found — BOLT IF",
              description: "We couldn't find that series.",
              url,
            },
            404,
            "We couldn't find that series. The link may be old or mistyped.",
          );
        }
        if (dbHit.event) {
          return htmlResponse(baseHtml, eventMeta(dbHit.event, url), 200);
        }
        return htmlResponse(
          baseHtml,
          {
            title: `${dbHit.seriesTitle ?? "BOLT IF"} — BOLT IF`,
            description: "No upcoming sessions open for RSVP right now.",
            url,
          },
          200,
        );
      } catch {
        return htmlResponse(baseHtml, genericMeta(url), 200);
      }
    });
}

/** Empty `/api/v1` sub-app so `src/worker/registry.ts` auto-mount stays happy. */
export default new Hono<AppEnv>();
