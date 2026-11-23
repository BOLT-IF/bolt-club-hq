/**
 * Minimal browser error reporter that posts to Sentry's envelope endpoint. It
 * avoids `@sentry/browser`, which is not installed (see docs/DECISIONS.md, S0.7).
 * With no DSN it reports nothing, so local dev and tests stay silent.
 */

export interface ParsedDsn {
  publicKey: string;
  host: string;
  projectId: string;
}

export function parseDsn(dsn: string): ParsedDsn | null {
  const match = /^https:\/\/([^@]+)@([^/]+)\/(\d+)$/.exec(dsn);
  if (!match) {
    return null;
  }
  return { publicKey: match[1] ?? "", host: match[2] ?? "", projectId: match[3] ?? "" };
}

export function envelopeUrl(dsn: ParsedDsn): string {
  return `https://${dsn.host}/api/${dsn.projectId}/envelope/`;
}

export interface EventOptions {
  eventId: string;
  timestamp: number;
  release?: string;
  environment?: string;
}

/** Builds a Sentry v7 envelope (a header line, an item header line, then the event). */
export function buildEnvelope(error: unknown, dsn: ParsedDsn, options: EventOptions): string {
  const err = error instanceof Error ? error : new Error(String(error));
  const event = {
    event_id: options.eventId,
    timestamp: options.timestamp / 1000,
    platform: "javascript",
    level: "error",
    environment: options.environment,
    release: options.release,
    exception: {
      values: [{ type: err.name, value: scrubMessage(err.message) }],
    },
  };
  const eventJson = JSON.stringify(event);
  const header = {
    event_id: options.eventId,
    dsn: `https://${dsn.publicKey}@${dsn.host}/${dsn.projectId}`,
  };
  const itemHeader = { type: "event", length: new TextEncoder().encode(eventJson).length };
  return [JSON.stringify(header), JSON.stringify(itemHeader), eventJson].join("\n");
}

/** Removes email-like strings and long digit runs (possible account or card numbers) from messages. */
export function scrubMessage(message: string): string {
  return message.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/\d{6,}/g, "[number]");
}

export interface BrowserReporterOptions {
  dsn: string | undefined;
  environment?: string;
  release?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createBrowserReporter(options: BrowserReporterOptions): (error: unknown) => void {
  const parsed = options.dsn ? parseDsn(options.dsn) : null;
  if (!parsed) {
    return () => undefined;
  }
  const send = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const url = envelopeUrl(parsed);
  return (error) => {
    const body = buildEnvelope(error, parsed, {
      eventId: crypto.randomUUID().replace(/-/g, ""),
      timestamp: now(),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.release === undefined ? {} : { release: options.release }),
    });
    void send(url, { method: "POST", body, keepalive: true }).catch(() => undefined);
  };
}
