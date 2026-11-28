import type { PublishOgPort } from "../core/ports";
import type { EventStatus } from "../events/rules";

export interface OgEventData {
  readonly shareSlug: string;
  readonly title: string;
  readonly format: string;
  readonly location: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: EventStatus;
}

export interface OgMeta {
  readonly title: string;
  readonly description: string;
  readonly url: string;
}

const TZ = "Europe/Stockholm";

/** Production `PublishOgPort`: writes the public JSON snapshot to Workers KV (`og:event:<slug>`). */
export function createKvPublishOg(env: Cloudflare.Env): PublishOgPort {
  return {
    async publishOg({ key, html }) {
      const kv = (env as { KV?: KVNamespace }).KV;
      if (!kv) return;
      await kv.put(key, html);
    },
  };
}

export function seriesOgKey(slug: string): string {
  return `og:series:${slug}`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function parseOgSnapshot(raw: string): OgEventData | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.slug !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.format !== "string" ||
      typeof parsed.startsAt !== "string" ||
      typeof parsed.endsAt !== "string" ||
      typeof parsed.status !== "string"
    ) {
      return null;
    }
    const startsAt = new Date(parsed.startsAt);
    const endsAt = new Date(parsed.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return null;
    return {
      shareSlug: parsed.slug,
      title: parsed.title,
      format: parsed.format,
      location: typeof parsed.location === "string" ? parsed.location : null,
      startsAt,
      endsAt,
      status: parsed.status as EventStatus,
    };
  } catch {
    return null;
  }
}

function formatWhen(startsAt: Date, endsAt: Date): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: TZ,
  }).format(startsAt);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: TZ,
  });
  return `${day}, ${time.format(startsAt)}–${time.format(endsAt)}`;
}

export function formatOgDescription(event: OgEventData): string {
  const parts = [formatWhen(event.startsAt, event.endsAt)];
  if (event.location) parts.push(`@ ${event.location}`);
  if (event.status === "cancelled") parts.push("(Cancelled)");
  return parts.join(" ");
}

export function buildOgHeadTags(meta: OgMeta): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const url = escapeHtml(meta.url);
  return [
    `<meta name="robots" content="noindex, nofollow" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="BOLT IF" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
  ].join("\n    ");
}

const DEFAULT_HTML_SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>BOLT HQ</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/app/main.tsx"></script>
  </body>
</html>`;

export function injectOgIntoHtml(
  baseHtml: string | null,
  meta: OgMeta,
  bodyFallback?: string,
): string {
  const html = baseHtml ?? DEFAULT_HTML_SHELL;
  const escapedTitle = escapeHtml(meta.title);
  const tags = buildOgHeadTags(meta);

  let out = /<title>[\s\S]*?<\/title>/i.test(html)
    ? html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapedTitle}</title>`)
    : html.replace(/<\/head>/i, () => `<title>${escapedTitle}</title>\n  </head>`);

  out = /<\/head>/i.test(out)
    ? out.replace(/<\/head>/i, () => `    ${tags}\n  </head>`)
    : `${tags}\n${out}`;

  if (bodyFallback) {
    const escapedBody = escapeHtml(bodyFallback);
    out = out.replace(
      /<div id="root"><\/div>/i,
      () => `<div id="root"><p>${escapedBody}</p></div>`,
    );
  }
  return out;
}
