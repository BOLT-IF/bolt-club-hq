import type { CurrentMember } from "../core/ports";

/** PLAN §3: RSVP closes 24h before start by default. */
export const DEFAULT_CLOSE_BEFORE_MS = 24 * 3_600_000;
/** PLAN §3: the organizer sets the guest limit, default 1. */
export const DEFAULT_MAX_GUESTS = 1;

const FORMATS = ["MD", "WD", "XD", "mixed", "open"] as const;
const MODES = ["tiered", "instant"] as const;
const FIELDS = new Set([
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
]);

export interface OneoffPlan {
  kind: "member_oneoff" | "admin_oneoff";
  title: string;
  location: string | null;
  format: (typeof FORMATS)[number];
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  maxGuestsPerMember: number;
  rsvpCloseAt: Date;
  /** Whole kronor. Always 0 for member one-offs. */
  adhocFee: number;
  allocationMode: (typeof MODES)[number];
}

export type PlanResult =
  | { ok: true; value: OneoffPlan }
  | { ok: false; status: 400 | 403; error: "invalid_body" | "admin_only"; message: string };

const bad = (message: string): PlanResult => ({
  ok: false,
  status: 400,
  error: "invalid_body",
  message,
});

const isInt = (v: unknown, min: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min;

function instant(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Validates a one-off create body and decides its kind (PLAN §5.2 inv. 6, §6.8).
 * Members: free and instant only; a fee or tiered allocation is 403 `admin_only`.
 * Admins: optional fee; tiered by default, instant allowed only when free (instant never charges).
 */
export function planOneoff(actor: CurrentMember, body: unknown, now: Date): PlanResult {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return bad("Send a JSON object");
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => !FIELDS.has(k));
  if (unknown) return bad(`Unknown field: ${unknown}`);

  if (typeof b.title !== "string" || b.title.trim() === "") return bad("Give the event a title");
  if (b.location != null && typeof b.location !== "string") return bad("Location must be text");
  const format = b.format ?? "open";
  if (!FORMATS.includes(format as OneoffPlan["format"])) return bad("Unknown format");

  const startsAt = instant(b.startsAt);
  const endsAt = instant(b.endsAt);
  if (!startsAt || !endsAt) return bad("Start and end must be ISO timestamps");
  if (startsAt <= now) return bad("The event must start in the future");
  if (endsAt <= startsAt) return bad("The event must end after it starts");

  if (!isInt(b.capacity, 1)) return bad("Spots must be a whole number of at least 1");
  const maxGuests = b.maxGuestsPerMember ?? DEFAULT_MAX_GUESTS;
  if (!isInt(maxGuests, 0)) return bad("Guests per member must be a whole number");

  let rsvpCloseAt: Date;
  if (b.rsvpCloseAt === undefined) {
    const byDefault = new Date(startsAt.getTime() - DEFAULT_CLOSE_BEFORE_MS);
    // Created less than 24h ahead: RSVPs stay open until the start.
    rsvpCloseAt = byDefault > now ? byDefault : startsAt;
  } else {
    const close = instant(b.rsvpCloseAt);
    if (!close) return bad("RSVP close must be an ISO timestamp");
    if (close <= now || close > startsAt)
      return bad("RSVP close must be between now and the start");
    rsvpCloseAt = close;
  }

  const fee = b.adhocFee ?? 0;
  if (!isInt(fee, 0)) return bad("The fee must be whole kronor");
  if (
    b.allocationMode !== undefined &&
    !MODES.includes(b.allocationMode as OneoffPlan["allocationMode"])
  ) {
    return bad("Unknown allocation mode");
  }
  const requestedMode = b.allocationMode as OneoffPlan["allocationMode"] | undefined;

  const isAdmin = actor.role === "admin";
  if (!isAdmin && (fee !== 0 || requestedMode === "tiered")) {
    return {
      ok: false,
      status: 403,
      error: "admin_only",
      message: "Only admins can set a fee or tiered allocation",
    };
  }
  const allocationMode = isAdmin ? (requestedMode ?? "tiered") : "instant";
  if (allocationMode === "instant" && fee > 0) return bad("A paid event needs tiered allocation");

  return {
    ok: true,
    value: {
      kind: isAdmin ? "admin_oneoff" : "member_oneoff",
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
    },
  };
}

/**
 * RSVP tier for a member (PLAN §6.8): one-offs have no tier 1, so a pass holder is tier 2
 * like everyone else and pays an admin one-off's fee. Only series events honour the pass.
 * S4.2 calls this with the `isPrepaid` answer.
 */
export function rsvpTier(
  e: { kind: "series" | "member_oneoff" | "admin_oneoff" },
  isPrepaid: boolean,
): 1 | 2 {
  return e.kind === "series" && isPrepaid ? 1 : 2;
}
