import { eq } from "drizzle-orm";

import { clubSettings } from "../../../../db/schema";
import type { NotificationPolicy } from "../policy";

/** `HH:MM`, 24 h, Stockholm wall-clock time (the S2.3 `club_settings.quiet_hours` shape). */
export interface QuietHours {
  start: string;
  end: string;
}

/** PLAN A9: 22:00-08:00. Used until the club saves settings (S2.3 default). */
export const DEFAULT_QUIET_HOURS: QuietHours = { start: "22:00", end: "08:00" };

const ZONE = "Europe/Stockholm";

const stockholm = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Stockholm wall-clock parts of an instant. */
function localParts(at: Date): { y: number; m: number; d: number; minutes: number } {
  const p = Object.fromEntries(stockholm.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function toMinutes(hhmm: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** The UTC instant of Stockholm wall time `minutes` on local date y-m-d (DST-safe). */
function stockholmInstant(y: number, m: number, d: number, minutes: number): Date {
  // Guess as if UTC, then correct by the zone offset at the guess (twice covers DST edges).
  let guess = Date.UTC(y, m - 1, d, 0, minutes);
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess));
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, 0, p.minutes);
    guess += Date.UTC(y, m - 1, d, 0, minutes) - asUtc;
  }
  return new Date(guess);
}

/**
 * When `now` is inside the quiet window, returns the instant it ends (Stockholm time);
 * otherwise null. The window is [start, end); it may cross midnight. Missing or
 * start === end means no quiet hours.
 */
export function quietUntil(now: Date, window: QuietHours | null): Date | null {
  if (!window) return null;
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === null || end === null || start === end) return null;

  const local = localParts(now);
  const t = local.minutes;
  const crossesMidnight = start > end;
  const inside = crossesMidnight ? t >= start || t < end : t >= start && t < end;
  if (!inside) return null;

  // Ends today, unless we are in the evening part of a window that crosses midnight.
  const endsTomorrow = crossesMidnight && t >= start;
  const day = new Date(Date.UTC(local.y, local.m - 1, local.d + (endsTomorrow ? 1 : 0)));
  return stockholmInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), end);
}

function asQuietHours(value: unknown): QuietHours | null {
  if (typeof value !== "object" || value === null) return null;
  const { start, end } = value as Record<string, unknown>;
  return typeof start === "string" && typeof end === "string" ? { start, end } : null;
}

/** Reads the club's window: default before settings exist, null when switched off. */
export async function clubQuietHours(db: Parameters<NotificationPolicy["evaluate"]>[0]["db"]) {
  const [row] = await db
    .select({ quietHours: clubSettings.quietHours })
    .from(clubSettings)
    .where(eq(clubSettings.id, 1));
  return row ? asQuietHours(row.quietHours) : DEFAULT_QUIET_HOURS;
}

/** PLAN §10 slot 20: during quiet hours the push waits; the inbox row is already written. */
const quietHours: NotificationPolicy = {
  id: "quiet-hours",
  order: 20,
  async evaluate({ db, clock }) {
    const until = quietUntil(clock.now(), await clubQuietHours(db));
    return until ? { action: "defer", until, reason: "quiet hours" } : { action: "allow" };
  },
};

export default quietHours;
