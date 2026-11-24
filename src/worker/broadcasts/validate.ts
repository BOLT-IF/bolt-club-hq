import type { Audience } from "./audience";

export const TITLE_MAX = 100;
export const BODY_MAX = 1000;

export interface BroadcastDraft {
  title: string;
  body: string;
  audience: Audience;
}

export type ParseResult = { ok: true; value: BroadcastDraft } | { ok: false; error: string };

const text = (v: unknown): string | null => (typeof v === "string" ? v.trim() : null);

function parseAudience(raw: unknown): Audience | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { kind, seriesId, eventId } = raw as Record<string, unknown>;
  const series = text(seriesId);
  switch (kind) {
    case "all":
      return { kind: "all" };
    case "pass_holders":
    case "captains":
      return series ? { kind, seriesId: series } : { kind };
    case "event_rsvps": {
      const event = text(eventId);
      return event ? { kind, eventId: event } : null;
    }
    default:
      return null;
  }
}

/** Validates the POST /admin/broadcasts body. Text is trimmed. */
export function parseBroadcast(input: unknown): ParseResult {
  if (typeof input !== "object" || input === null) return { ok: false, error: "invalid_body" };
  const raw = input as Record<string, unknown>;
  const title = text(raw.title);
  const body = text(raw.body);
  if (!title) return { ok: false, error: "title_required" };
  if (title.length > TITLE_MAX) return { ok: false, error: "title_too_long" };
  if (!body) return { ok: false, error: "body_required" };
  if (body.length > BODY_MAX) return { ok: false, error: "body_too_long" };
  const audience = parseAudience(raw.audience);
  if (!audience) return { ok: false, error: "invalid_audience" };
  return { ok: true, value: { title, body, audience } };
}
