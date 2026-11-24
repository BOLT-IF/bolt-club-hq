/**
 * Weekly recurrence for term series (PLAN §5.1 Series, §11.5). Pure: no I/O, no clock.
 *
 * Series times are wall-clock times in the club's zone (Europe/Stockholm). Each
 * occurrence is resolved to a UTC instant on its own date through `Intl`, so 19:00
 * stays 19:00 local on both sides of a DST shift. `rsvpCloseAt` and `endsAt` are
 * absolute offsets from the start in minutes (PLAN §11.5), not local-time maths.
 */

export const CLUB_TIME_ZONE = "Europe/Stockholm";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface LocalParts {
  /** `YYYY-MM-DD` */
  readonly date: string;
  /** `HH:MM`, 24 h */
  readonly time: string;
  /** ISO weekday, Monday = 1 … Sunday = 7 */
  readonly weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

const pad = (n: number) => String(n).padStart(2, "0");

function parseDate(date: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`recurrence: bad date ${date}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function parseTime(time: string): { h: number; min: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`recurrence: bad time ${time}`);
  return { h: Number(match[1]), min: Number(match[2]) };
}

/** Calendar date ↔ epoch-day maths in UTC: no zone, no DST. */
const dateToDayMs = (date: string) => {
  const { y, m, d } = parseDate(date);
  return Date.UTC(y, m - 1, d);
};
const dayMsToDate = (ms: number) => {
  const day = new Date(ms);
  return `${String(day.getUTCFullYear())}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
};

/** ISO weekday (Monday = 1) of a calendar date. */
export function isoWeekday(date: string): number {
  const js = new Date(dateToDayMs(date)).getUTCDay();
  return js === 0 ? 7 : js;
}

/** Wall-clock date, time and weekday of `instant` in `timeZone`. */
export function localParts(instant: Date, timeZone = CLUB_TIME_ZONE): LocalParts {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}`;
  return { date, time: `${parts.hour ?? ""}:${parts.minute ?? ""}`, weekday: isoWeekday(date) };
}

/** Zone offset (local minus UTC) in minutes at `ms`. */
function offsetMin(ms: number, timeZone: string): number {
  const { date, time } = localParts(new Date(ms), timeZone);
  const { h, min } = parseTime(time);
  const asUtc = dateToDayMs(date) + (h * 60 + min) * MINUTE_MS;
  return Math.round((asUtc - Math.floor(ms / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

/**
 * The UTC instant of wall-clock `date` `time` in `timeZone`.
 * - Repeated hour (autumn): the first one, i.e. summer time.
 * - Skipped hour (spring): moved forward by the gap, so 02:30 becomes 03:30.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone = CLUB_TIME_ZONE): Date {
  const { h, min } = parseTime(time);
  const localMs = dateToDayMs(date) + (h * 60 + min) * MINUTE_MS;
  const before = offsetMin(localMs - DAY_MS, timeZone);
  const after = offsetMin(localMs + DAY_MS, timeZone);
  for (const off of [Math.max(before, after), Math.min(before, after)]) {
    const candidate = localMs - off * MINUTE_MS;
    if (offsetMin(candidate, timeZone) === off) return new Date(candidate);
  }
  return new Date(localMs - before * MINUTE_MS);
}

export interface WeeklyRule {
  /** First and last calendar day of the term, inclusive, `YYYY-MM-DD`. */
  readonly startsOn: string;
  readonly endsOn: string;
  /** ISO weekday, Monday = 1. */
  readonly weekday: number;
  /** Local `HH:MM`. */
  readonly startTime: string;
  readonly durationMin: number;
  readonly rsvpCloseOffsetMin: number;
  readonly skipDates?: readonly string[];
  readonly timeZone?: string;
}

export interface Occurrence {
  /** Local calendar date: the occurrence's identity within its series. */
  readonly date: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly rsvpCloseAt: Date;
}

/** Instants for one occurrence. Exposed so occurrence edits use the same maths. */
export function occurrenceAt(
  date: string,
  startTime: string,
  durationMin: number,
  rsvpCloseOffsetMin: number,
  timeZone = CLUB_TIME_ZONE,
): Occurrence {
  const startsAt = zonedTimeToUtc(date, startTime, timeZone);
  const start = startsAt.getTime();
  return {
    date,
    startsAt,
    endsAt: new Date(start + durationMin * MINUTE_MS),
    rsvpCloseAt: new Date(start - rsvpCloseOffsetMin * MINUTE_MS),
  };
}

/** Every `weekday` from `startsOn` to `endsOn` inclusive, minus skip-dates, oldest first. */
export function weeklyOccurrences(rule: WeeklyRule): Occurrence[] {
  const skip = new Set(rule.skipDates ?? []);
  const last = dateToDayMs(rule.endsOn);
  let day = dateToDayMs(rule.startsOn);
  const firstWeekday = isoWeekday(rule.startsOn);
  day += ((rule.weekday - firstWeekday + 7) % 7) * DAY_MS;
  const out: Occurrence[] = [];
  for (; day <= last; day += 7 * DAY_MS) {
    const date = dayMsToDate(day);
    if (skip.has(date)) continue;
    out.push(
      occurrenceAt(date, rule.startTime, rule.durationMin, rule.rsvpCloseOffsetMin, rule.timeZone),
    );
  }
  return out;
}
