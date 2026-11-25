import type { CurrentMember } from "../core/ports";
import type { EventAudienceKind } from "./audience";

const FORMATS = ["MD", "WD", "XD", "mixed", "open"] as const;
const MODES = ["tiered", "instant"] as const;
const SCOPES = ["club", "member"] as const;
const AUDIENCE_KINDS = ["all", "series", "members"] as const;
const MAX_TITLE = 80;
const MAX_LOCATION = 120;
const DEFAULT_MAX_GUESTS = 1;
const DEFAULT_CLOSE_BEFORE_MS = 24 * 60 * 60 * 1000;

const ALLOWED_KEYS = new Set([
  "title",
  "location",
  "format",
  "startsAt",
  "endsAt",
  "capacity",
  "maxGuestsPerMember",
  "rsvpCloseAt",
  "adhocFee",
  "allocationMode",
  "eventScope",
  "audienceKind",
  "audienceSeriesId",
  "eligibleMemberIds",
]);

export interface OneoffPlan {
  readonly kind: "member_oneoff" | "admin_oneoff";
  readonly title: string;
  readonly location: string | null;
  readonly format: (typeof FORMATS)[number];
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly capacity: number;
  readonly maxGuestsPerMember: number;
  readonly rsvpCloseAt: Date;
  readonly adhocFee: number;
  readonly allocationMode: (typeof MODES)[number];
  readonly status: "scheduled" | "closed";
  readonly closedProcessedAt: Date | null;
  readonly audienceKind: EventAudienceKind;
  readonly audienceSeriesId: string | null;
  readonly eligibleMemberIds: readonly string[];
}

export type PlanResult =
  | { readonly ok: true; readonly value: OneoffPlan }
  | {
      readonly ok: false;
      readonly status: 400 | 403;
      readonly error: string;
      readonly message: string;
    };

const bad = (message: string): PlanResult => ({
  ok: false,
  status: 400,
  error: "invalid_body",
  message,
});

const isInt = (v: unknown, min: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min;

const instant = (v: unknown): Date | null => {
  if (typeof v !== "string" || v.trim() === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Validates a `POST /events` one-off body and enforces role rules:
 * - Member-organized events (`member_oneoff`): instant confirmation, optional informational cost
 *   (`adhocFee` settled outside the app — never billed by BOLT IF).
 * - Club events (`admin_oneoff`, admin only): billed via BOLT HQ when `adhocFee > 0`.
 *   - Starts in < 24h (with default close): confirms immediately (`instant`).
 *   - Paid + instant club events start in `"closed"` state so RSVPs confirm & charge immediately
 *     and cancellations follow late-cancel/refill rules.
 */
export function planOneoff(actor: CurrentMember, body: unknown, now: Date): PlanResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return bad("Expected a JSON object");
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!ALLOWED_KEYS.has(key)) return bad(`Unknown field: ${key}`);
  }

  if (typeof b.title !== "string" || b.title.trim() === "" || b.title.trim().length > MAX_TITLE) {
    return bad(`Title is required (up to ${String(MAX_TITLE)} characters)`);
  }
  if (
    b.location !== undefined &&
    b.location !== null &&
    (typeof b.location !== "string" || b.location.trim().length > MAX_LOCATION)
  ) {
    return bad(`Location may be at most ${String(MAX_LOCATION)} characters`);
  }
  const format = b.format ?? "open";
  if (typeof format !== "string" || !(FORMATS as readonly string[]).includes(format)) {
    return bad("Unknown format");
  }

  const startsAt = instant(b.startsAt);
  const endsAt = instant(b.endsAt);
  if (!startsAt || !endsAt) return bad("Start and end must be ISO timestamps");
  if (startsAt <= now) return bad("The event must start in the future");
  if (endsAt <= startsAt) return bad("The event must end after it starts");

  if (!isInt(b.capacity, 1)) return bad("Spots must be a whole number of at least 1");
  const maxGuests = b.maxGuestsPerMember ?? DEFAULT_MAX_GUESTS;
  if (!isInt(maxGuests, 0)) return bad("Guests per member must be a whole number");

  const fee = b.adhocFee ?? 0;
  if (!isInt(fee, 0)) return bad("The fee must be whole kronor");

  if (
    b.allocationMode !== undefined &&
    (typeof b.allocationMode !== "string" ||
      !(MODES as readonly string[]).includes(b.allocationMode))
  ) {
    return bad("Unknown allocation mode");
  }
  const requestedMode = b.allocationMode as OneoffPlan["allocationMode"] | undefined;

  if (
    b.eventScope !== undefined &&
    (typeof b.eventScope !== "string" || !(SCOPES as readonly string[]).includes(b.eventScope))
  ) {
    return bad("Unknown event scope");
  }
  const requestedScope = b.eventScope as (typeof SCOPES)[number] | undefined;

  const isAdmin = actor.role === "admin";
  if (!isAdmin && (requestedScope === "club" || requestedMode === "tiered")) {
    return {
      ok: false,
      status: 403,
      error: "admin_only",
      message: "Only admins can create club-billed or tiered events",
    };
  }

  const kind: OneoffPlan["kind"] =
    isAdmin && requestedScope !== "member" ? "admin_oneoff" : "member_oneoff";

  if (kind === "member_oneoff" && requestedMode === "tiered") {
    return bad("Member-organized events always confirm immediately");
  }

  const startsWithin24h = startsAt.getTime() - now.getTime() < DEFAULT_CLOSE_BEFORE_MS;

  // Audience validation (all / series pass holders / specific members).
  const rawAudienceKind = b.audienceKind ?? "all";
  if (
    typeof rawAudienceKind !== "string" ||
    !(AUDIENCE_KINDS as readonly string[]).includes(rawAudienceKind)
  ) {
    return bad("Unknown audience kind");
  }
  const audienceKind = rawAudienceKind as EventAudienceKind;
  let audienceSeriesId: string | null = null;
  let eligibleMemberIds: string[] = [];

  if (audienceKind === "series") {
    if (typeof b.audienceSeriesId !== "string" || b.audienceSeriesId.trim() === "") {
      return bad("Select a series for this group");
    }
    audienceSeriesId = b.audienceSeriesId.trim();
  } else if (b.audienceSeriesId !== undefined && b.audienceSeriesId !== null) {
    return bad("audienceSeriesId is only allowed when audienceKind is series");
  }

  if (audienceKind === "members") {
    if (
      !Array.isArray(b.eligibleMemberIds) ||
      b.eligibleMemberIds.length === 0 ||
      b.eligibleMemberIds.length > 500 ||
      !b.eligibleMemberIds.every((id) => typeof id === "string" && id.trim() !== "")
    ) {
      return bad("Pick at least one eligible member");
    }
    eligibleMemberIds = [...new Set((b.eligibleMemberIds as string[]).map((id) => id.trim()))];
  } else if (b.eligibleMemberIds !== undefined && b.eligibleMemberIds !== null) {
    if (!Array.isArray(b.eligibleMemberIds) || b.eligibleMemberIds.length > 0) {
      return bad("eligibleMemberIds is only allowed when audienceKind is members");
    }
  }

  let allocationMode: OneoffPlan["allocationMode"];
  if (kind === "member_oneoff") {
    allocationMode = "instant";
  } else if (startsWithin24h && b.rsvpCloseAt === undefined) {
    // Starts within 24 hours: confirm right away instead of waiting until startAt.
    allocationMode = "instant";
  } else {
    allocationMode = requestedMode ?? "tiered";
  }

  // Paid club events in instant mode start in `closed` state so RSVPs confirm & charge immediately
  // and cancellations follow late-cancel/refill rules.
  const immediatePaidClub = kind === "admin_oneoff" && allocationMode === "instant" && fee > 0;

  let rsvpCloseAt: Date;
  if (immediatePaidClub) {
    rsvpCloseAt = now;
  } else if (b.rsvpCloseAt === undefined) {
    const byDefault = new Date(startsAt.getTime() - DEFAULT_CLOSE_BEFORE_MS);
    rsvpCloseAt = byDefault > now ? byDefault : startsAt;
  } else {
    const close = instant(b.rsvpCloseAt);
    if (!close) return bad("RSVP close must be an ISO timestamp");
    if (close <= now || close > startsAt) {
      return bad("RSVP close must be between now and the start");
    }
    rsvpCloseAt = close;
  }

  return {
    ok: true,
    value: {
      kind,
      title: b.title.trim(),
      location:
        typeof b.location === "string" && b.location.trim() !== "" ? b.location.trim() : null,
      format: format as OneoffPlan["format"],
      startsAt,
      endsAt,
      capacity: b.capacity,
      maxGuestsPerMember: maxGuests,
      rsvpCloseAt,
      adhocFee: fee,
      allocationMode,
      status: immediatePaidClub ? "closed" : "scheduled",
      closedProcessedAt: immediatePaidClub ? now : null,
      audienceKind,
      audienceSeriesId,
      eligibleMemberIds,
    },
  };
}

/**
 * RSVP tier for a member (PLAN §6.8): one-offs have no tier 1, so a pass holder is tier 2
 * like everyone else and pays an admin one-off's fee. Only series events honour the pass.
 */
export function rsvpTier(
  e: { kind: "series" | "member_oneoff" | "admin_oneoff" },
  isPrepaid: boolean,
): 1 | 2 {
  return e.kind === "series" && isPrepaid ? 1 : 2;
}
