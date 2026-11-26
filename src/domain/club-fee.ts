import { localParts } from "./recurrence";

export type TermSeason = "fall" | "spring";

function parseYearMonth(startsOn: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(startsOn);
  if (!match) throw new Error(`club-fee: invalid date ${startsOn}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`club-fee: invalid month in ${startsOn}`);
  return { year, month };
}

/** Month 7..12 -> "fall", month 1..6 -> "spring". */
export function inferTermSeason(startsOn: string): TermSeason {
  const { month } = parseYearMonth(startsOn);
  return month >= 7 ? "fall" : "spring";
}

/** Fall Y and Spring Y+1 share clubYear Y (e.g. Fall 2026 + Spring 2027 -> 2026). */
export function inferClubYear(startsOn: string, season?: TermSeason): number {
  const { year } = parseYearMonth(startsOn);
  const resolvedSeason = season ?? inferTermSeason(startsOn);
  return resolvedSeason === "fall" ? year : year - 1;
}

/** Infers membership year and season at `now` using Stockholm local date. */
export function inferClubYearFromDate(now: Date): { clubYear: number; season: TermSeason } {
  const { date } = localParts(now);
  const season = inferTermSeason(date);
  return { clubYear: inferClubYear(date, season), season };
}

/** Resolves a term's season and clubYear, falling back to `startsOn` when nullable columns are unset. */
export function resolveTermMembershipPeriod(t: {
  startsOn: string;
  season: TermSeason | null;
  clubYear: number | null;
}): { season: TermSeason; clubYear: number } {
  const season = t.season ?? inferTermSeason(t.startsOn);
  const clubYear = t.clubYear ?? inferClubYear(t.startsOn, season);
  return { season, clubYear };
}

export function formatClubYear(clubYear: number): string {
  return `${String(clubYear)}/${String(clubYear + 1)}`;
}
