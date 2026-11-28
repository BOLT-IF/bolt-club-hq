import type { TermSeason } from "../../domain/club-fee";
import { TERM_STATUSES, type TermStatus } from "./rules";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

type Fields = Record<string, unknown>;
type Field<T> = (value: unknown) => T | undefined;

function asObject(input: unknown): Fields | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Fields)
    : null;
}

const text: Field<string> = (v) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 200 ? v.trim() : undefined;

const nullableText: Field<string | null> = (v) => (v === null ? null : text(v));

const wholeNumber =
  (min: number, max = 10_000_000): Field<number> =>
  (v) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;

const nullableWholeNumber =
  (min: number, max = 10_000_000): Field<number | null> =>
  (v) =>
    v === null ? null : wholeNumber(min, max)(v);

const memberIdArray: Field<string[]> = (v) =>
  Array.isArray(v) && v.length <= 500 && v.every((id) => typeof id === "string" && id.length > 0)
    ? [...new Set(v as string[])]
    : undefined;

/** A real calendar date, YYYY-MM-DD. */
const isoDate: Field<string> = (v) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? undefined : v;
};

const clockTime: Field<string> = (v) =>
  typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined;

const FORMATS = [
  "Men's Doubles",
  "Mixed Doubles",
  "Women's Doubles",
  "Singles",
  "Training",
  "Open",
] as const;
export type SeriesFormat = (typeof FORMATS)[number];
const format: Field<SeriesFormat> = (v) => FORMATS.find((f) => f === v);

const termStatus: Field<TermStatus> = (v) => TERM_STATUSES.find((s) => s === v);
const termSeason: Field<TermSeason> = (v) => (v === "fall" || v === "spring" ? v : undefined);
const clubYearField = wholeNumber(2000, 2100);

/** Reads `specs` from `input`. Unknown keys are errors; `required` keys must be present. */
function read(
  input: unknown,
  specs: Record<string, Field<unknown>>,
  required: readonly string[],
  defaults: Fields = {},
): Parsed<Fields> {
  const obj = asObject(input);
  if (!obj) return fail("expected a JSON object");
  const out: Fields = { ...defaults };
  for (const key of Object.keys(obj)) {
    const spec = specs[key];
    if (!spec) return fail(`unknown field: ${key}`);
    const value = spec(obj[key]);
    if (value === undefined) return fail(`invalid ${key}`);
    out[key] = value;
  }
  for (const key of required) if (!(key in out)) return fail(`missing ${key}`);
  return { ok: true, value: out };
}

function orderedDates(v: Fields): string | null {
  const { startsOn, endsOn } = v as { startsOn?: string; endsOn?: string };
  return startsOn !== undefined && endsOn !== undefined && startsOn >= endsOn
    ? "startsOn must be before endsOn"
    : null;
}

export interface TermCreate {
  name: string;
  startsOn: string;
  endsOn: string;
  season?: TermSeason;
  clubYear?: number;
}

export function parseTermCreate(input: unknown): Parsed<TermCreate> {
  const r = read(
    input,
    { name: text, startsOn: isoDate, endsOn: isoDate, season: termSeason, clubYear: clubYearField },
    ["name", "startsOn", "endsOn"],
  );
  if (!r.ok) return r;
  const order = orderedDates(r.value);
  return order ? fail(order) : { ok: true, value: r.value as unknown as TermCreate };
}

export interface TermPatch {
  name?: string;
  startsOn?: string;
  endsOn?: string;
  status?: TermStatus;
  season?: TermSeason;
  clubYear?: number;
}

export function parseTermPatch(input: unknown): Parsed<TermPatch> {
  const r = read(
    input,
    {
      name: text,
      startsOn: isoDate,
      endsOn: isoDate,
      status: termStatus,
      season: termSeason,
      clubYear: clubYearField,
    },
    [],
  );
  if (!r.ok) return r;
  if (Object.keys(r.value).length === 0) return fail("nothing to change");
  const order = orderedDates(r.value);
  return order ? fail(order) : { ok: true, value: r.value };
}

export interface CloneInput {
  name?: string;
  startsOn: string;
  endsOn: string;
  season?: TermSeason;
  clubYear?: number;
}

export function parseClone(input: unknown): Parsed<CloneInput> {
  const r = read(
    input,
    { name: text, startsOn: isoDate, endsOn: isoDate, season: termSeason, clubYear: clubYearField },
    ["startsOn", "endsOn"],
  );
  if (!r.ok) return r;
  const order = orderedDates(r.value);
  return order ? fail(order) : { ok: true, value: r.value as unknown as CloneInput };
}

const SERIES_SPECS = {
  name: text,
  format,
  level: nullableText,
  weekday: wholeNumber(1, 7),
  startTime: clockTime,
  durationMin: wholeNumber(1, 24 * 60),
  location: nullableText,
  capacity: wholeNumber(1, 1000),
  passPrice: wholeNumber(0),
  discountedPassPrice: nullableWholeNumber(0),
  adhocFee: wholeNumber(0),
  maxGuestsDefault: wholeNumber(0, 20),
  rsvpCloseOffsetMin: wholeNumber(0, 60 * 24 * 30),
} satisfies Record<string, Field<unknown>>;

export interface SeriesCreate {
  termId: string;
  name: string;
  format: SeriesFormat;
  level?: string | null;
  weekday: number;
  startTime: string;
  durationMin: number;
  location?: string | null;
  capacity: number;
  passPrice: number;
  discountedPassPrice?: number | null;
  adhocFee: number;
  maxGuestsDefault: number;
  rsvpCloseOffsetMin: number;
  discountEligibleIds?: string[];
}

export function parseSeriesCreate(input: unknown): Parsed<SeriesCreate> {
  const r = read(
    input,
    { termId: text, ...SERIES_SPECS, discountEligibleIds: memberIdArray },
    [
      "termId",
      "name",
      "format",
      "weekday",
      "startTime",
      "durationMin",
      "capacity",
      "passPrice",
      "adhocFee",
    ],
    // PLAN §2: the organizer sets the guest limit, default 1. RSVP closes 24h before start.
    { maxGuestsDefault: 1, rsvpCloseOffsetMin: 1440 },
  );
  return r.ok ? { ok: true, value: r.value as unknown as SeriesCreate } : r;
}

export type SeriesPatchField = keyof typeof SERIES_SPECS;

export interface SeriesPatch {
  name?: string;
  format?: SeriesFormat;
  level?: string | null;
  weekday?: number;
  startTime?: string;
  durationMin?: number;
  location?: string | null;
  capacity?: number;
  passPrice?: number;
  discountedPassPrice?: number | null;
  adhocFee?: number;
  maxGuestsDefault?: number;
  rsvpCloseOffsetMin?: number;
  /** Admin only: allow a capacity that puts the pass cap below passes sold (PLAN §6.6). */
  overrideCapBelowSold?: boolean;
}

const bool: Field<boolean> = (v) => (typeof v === "boolean" ? v : undefined);

export function parseSeriesPatch(input: unknown): Parsed<SeriesPatch> {
  const r = read(input, { ...SERIES_SPECS, overrideCapBelowSold: bool }, []);
  if (!r.ok) return r;
  return Object.keys(r.value).length === 0
    ? fail("nothing to change")
    : { ok: true, value: r.value };
}

/** A captain runs the series day to day; money, capacity and identity stay with admins. */
export const CAPTAIN_EDITABLE_FIELDS: readonly SeriesPatchField[] = [
  "location",
  "maxGuestsDefault",
  "rsvpCloseOffsetMin",
];

export function parseMemberIds(input: unknown, max = 500): Parsed<string[]> {
  const obj = asObject(input);
  const ids = obj?.memberIds;
  if (!Array.isArray(ids) || ids.length > max || !ids.every((id) => typeof id === "string" && id)) {
    return fail("memberIds must be a list of member ids");
  }
  return { ok: true, value: [...new Set(ids as string[])] };
}

export const parseCaptainIds = (input: unknown) => parseMemberIds(input, 50);
