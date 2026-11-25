/** Pure poll rules (S9.1, S9.2, PLAN §10). No I/O; time comes in as `now`. */

import { isValidMediaKey } from "../media/validate";

export const RESULTS_VISIBILITY = ["always", "after_vote", "after_close", "admins"] as const;
export type ResultsVisibility = (typeof RESULTS_VISIBILITY)[number];

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 20;
export const MAX_IMAGES_PER_POLL = 8;
const MAX_QUESTION = 300;
const MAX_LABEL = 120;

export interface PollRules {
  multiChoice: boolean;
  closesAt: Date | null;
  resultsVisibility: ResultsVisibility;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A poll is closed from `closesAt` on. No closing date means open until an admin closes it. */
export function isClosed(poll: Pick<PollRules, "closesAt">, now: Date): boolean {
  return poll.closesAt !== null && poll.closesAt.getTime() <= now.getTime();
}

export type ChoiceResult = { ok: true; optionIds: string[] } | { ok: false; error: string };

/** Checks a ballot against the poll's choice mode and its own options. */
export function validateChoice(
  poll: Pick<PollRules, "multiChoice">,
  pollOptionIds: readonly string[],
  optionIds: unknown,
): ChoiceResult {
  if (!Array.isArray(optionIds) || !optionIds.every((id) => typeof id === "string")) {
    return { ok: false, error: "invalid_body" };
  }
  const ids = optionIds;
  if (ids.length === 0) return { ok: false, error: "no_choice" };
  if (new Set(ids).size !== ids.length) return { ok: false, error: "duplicate_option" };
  if (!poll.multiChoice && ids.length > 1) return { ok: false, error: "single_choice" };
  if (!ids.every((id) => pollOptionIds.includes(id))) return { ok: false, error: "unknown_option" };
  return { ok: true, optionIds: ids };
}

/**
 * Who sees results. Admins always do. `after_vote` also opens once the poll closes,
 * so members who never voted still learn the outcome. `admins` never opens to members.
 */
export function canSeeResults(
  poll: PollRules,
  viewer: { isAdmin: boolean; hasVoted: boolean },
  now: Date,
): boolean {
  if (viewer.isAdmin) return true;
  switch (poll.resultsVisibility) {
    case "always":
      return true;
    case "after_vote":
      return viewer.hasVoted || isClosed(poll, now);
    case "after_close":
      return isClosed(poll, now);
    case "admins":
      return false;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isVisibility = (v: unknown): v is ResultsVisibility =>
  typeof v === "string" && (RESULTS_VISIBILITY as readonly string[]).includes(v);

function parseQuestion(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const q = v.trim();
  return q === "" || q.length > MAX_QUESTION ? null : q;
}

/** A future instant, or null for "no closing date". Undefined means invalid. */
function parseClosesAt(v: unknown, now: Date): Date | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return undefined;
  const at = new Date(v);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return undefined;
  return at;
}

export interface CreatePoll {
  question: string;
  options: string[];
  optionImages?: (string | null)[];
  multiChoice: boolean;
  anonymous: boolean;
  resultsVisibility: ResultsVisibility;
  closesAt: Date | null;
}

const CREATE_KEYS = new Set([
  "question",
  "options",
  "optionImages",
  "multiChoice",
  "anonymous",
  "resultsVisibility",
  "closesAt",
]);

function parseOptionImages(
  raw: unknown,
  optionCount: number,
): Parsed<(string | null)[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length !== optionCount) {
    return { ok: false, error: "invalid_option_images" };
  }
  const keys: (string | null)[] = [];
  let count = 0;
  for (const item of raw) {
    if (item === null) {
      keys.push(null);
    } else if (typeof item === "string" && isValidMediaKey(item)) {
      keys.push(item);
      count++;
    } else {
      return { ok: false, error: "invalid_option_images" };
    }
  }
  if (count > MAX_IMAGES_PER_POLL) return { ok: false, error: "too_many_images" };
  return { ok: true, value: keys };
}

export function parseCreate(body: unknown, now: Date): Parsed<CreatePoll> {
  if (!isObject(body)) return { ok: false, error: "invalid_body" };
  if (Object.keys(body).some((k) => !CREATE_KEYS.has(k)))
    return { ok: false, error: "unknown_field" };

  const question = parseQuestion(body.question);
  if (question === null) return { ok: false, error: "invalid_question" };

  if (!Array.isArray(body.options)) return { ok: false, error: "invalid_options" };
  const options = body.options.map((o) => (typeof o === "string" ? o.trim() : ""));
  if (
    options.length < MIN_OPTIONS ||
    options.length > MAX_OPTIONS ||
    options.some((o) => o === "" || o.length > MAX_LABEL) ||
    new Set(options.map((o) => o.toLowerCase())).size !== options.length
  ) {
    return { ok: false, error: "invalid_options" };
  }

  const images = parseOptionImages(body.optionImages, options.length);
  if (!images.ok) return images;

  const { multiChoice = false, anonymous = false, resultsVisibility = "always" } = body;
  if (typeof multiChoice !== "boolean" || typeof anonymous !== "boolean") {
    return { ok: false, error: "invalid_settings" };
  }
  if (!isVisibility(resultsVisibility)) return { ok: false, error: "invalid_visibility" };

  const closesAt = parseClosesAt(body.closesAt, now);
  if (closesAt === undefined) return { ok: false, error: "invalid_closes_at" };

  return {
    ok: true,
    value: {
      question,
      options,
      ...(images.value === undefined ? {} : { optionImages: images.value }),
      multiChoice,
      anonymous,
      resultsVisibility,
      closesAt,
    },
  };
}

export interface PollPatch {
  question?: string;
  closesAt?: Date | null;
  resultsVisibility?: ResultsVisibility;
}

/**
 * Editable after creation: question, closing date (`close: true` closes now) and results
 * visibility. Anonymity, choice mode and options are fixed, so a vote is never reinterpreted
 * and an anonymous poll can never be turned into a named one.
 */
export function parsePatch(body: unknown, now: Date): Parsed<PollPatch> {
  if (!isObject(body) || Object.keys(body).length === 0)
    return { ok: false, error: "invalid_body" };
  const patch: PollPatch = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "question") {
      const q = parseQuestion(value);
      if (q === null) return { ok: false, error: "invalid_question" };
      patch.question = q;
    } else if (key === "close" && value === true) {
      patch.closesAt = now;
    } else if (key === "closesAt") {
      const at = parseClosesAt(value, now);
      if (at === undefined) return { ok: false, error: "invalid_closes_at" };
      patch.closesAt = at;
    } else if (key === "resultsVisibility" && isVisibility(value)) {
      patch.resultsVisibility = value;
    } else {
      return { ok: false, error: "field_not_editable" };
    }
  }
  return { ok: true, value: patch };
}
