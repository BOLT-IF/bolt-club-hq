/**
 * Worker Sentry reporter. It posts Sentry envelopes with `fetch`, so it needs no
 * Sentry SDK. toucan-js was tried and dropped: its types shadow the generated
 * `Cloudflare.Env` (see docs/DECISIONS.md, S0.7 and "dependency trim").
 */

/** Sentry DSN from the `SENTRY_DSN` secret or var. Unset means reporting is off. */
export interface SentryEnv {
  SENTRY_DSN?: string;
}

export interface SentryOptions {
  environment: string;
  release?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

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

/** Removes email-like strings and long digit runs (possible account or card numbers). */
export function scrubMessage(message: string): string {
  return message.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/\d{6,}/g, "[number]");
}

/** Strips credentials from request headers before an event leaves the Worker. */
export function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const copy = { ...headers };
  delete copy["authorization"];
  delete copy["cookie"];
  return copy;
}

/** Builds a Sentry v7 envelope: a header line, an item header line, then the event. */
export function buildEnvelope(
  error: unknown,
  dsn: ParsedDsn,
  options: {
    eventId: string;
    timestamp: number;
    environment: string;
    release?: string | undefined;
  },
): string {
  const err = error instanceof Error ? error : new Error(String(error));
  const event = {
    event_id: options.eventId,
    timestamp: options.timestamp / 1000,
    platform: "javascript",
    level: "error",
    environment: options.environment,
    ...(options.release === undefined ? {} : { release: options.release }),
    exception: { values: [{ type: err.name, value: scrubMessage(err.message) }] },
  };
  const eventJson = JSON.stringify(event);
  const header = {
    event_id: options.eventId,
    dsn: `https://${dsn.publicKey}@${dsn.host}/${dsn.projectId}`,
  };
  const itemHeader = { type: "event", length: new TextEncoder().encode(eventJson).length };
  return [JSON.stringify(header), JSON.stringify(itemHeader), eventJson].join("\n");
}

/**
 * Returns a reporter that posts one error to Sentry, or null when no DSN is set
 * (local dev and tests). Callers pass the reporter's promise to `waitUntil`.
 */
export function createSentryReporter(
  env: SentryEnv,
  options: SentryOptions,
): ((error: unknown) => Promise<void>) | null {
  const parsed = env.SENTRY_DSN ? parseDsn(env.SENTRY_DSN) : null;
  if (!parsed) {
    return null;
  }
  const send = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Math.round(performance.timeOrigin + performance.now()));
  const url = envelopeUrl(parsed);
  return async (error) => {
    const body = buildEnvelope(error, parsed, {
      eventId: crypto.randomUUID().replace(/-/g, ""),
      timestamp: now(),
      environment: options.environment,
      release: options.release,
    });
    await send(url, { method: "POST", body }).catch(() => undefined);
  };
}
