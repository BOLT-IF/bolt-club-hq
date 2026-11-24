import { TEMPLATE_MAX_LENGTH, unknownPlaceholders } from "./template";
import { RULE_KINDS, type ReminderRule, type RuleKind } from "./types";

export type RuleInput = Omit<ReminderRule, "id">;
export type ValidationResult =
  { ok: true; value: RuleInput } | { ok: false; errors: Record<string, string> };

const MAX_INTERVAL_DAYS = 366;
const MAX_HOURS_BEFORE_CLOSE = 24 * 14;
const MAX_THRESHOLD_SEK = 1_000_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Validates a create/replace body for `/admin/reminder-rules`. */
export function validateRuleInput(raw: unknown): ValidationResult {
  const errors: Record<string, string> = {};
  if (!isObject(raw)) return { ok: false, errors: { body: "must be an object" } };

  const kind = raw.kind;
  if (typeof kind !== "string" || !(RULE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, errors: { kind: `must be one of ${RULE_KINDS.join(", ")}` } };
  }
  const k = kind as RuleKind;

  const enabled = raw.enabled ?? true;
  if (typeof enabled !== "boolean") errors.enabled = "must be true or false";

  const minIntervalDays = raw.minIntervalDays ?? (k === "payment_due" ? 90 : 1);
  if (!isInt(minIntervalDays, 1, MAX_INTERVAL_DAYS)) {
    errors.minIntervalDays = `whole days, 1 to ${String(MAX_INTERVAL_DAYS)}`;
  }

  const template = raw.template;
  if (typeof template !== "string" || template.trim() === "") {
    errors.template = "required";
  } else if (template.length > TEMPLATE_MAX_LENGTH) {
    errors.template = `at most ${String(TEMPLATE_MAX_LENGTH)} characters`;
  } else {
    const unknown = unknownPlaceholders(k, template);
    if (unknown.length > 0) errors.template = `unknown placeholder: {${unknown.join("}, {")}}`;
  }

  const params = isObject(raw.params) ? raw.params : {};
  if (k === "payment_due") {
    if (!isInt(params.thresholdSek, 1, MAX_THRESHOLD_SEK)) {
      errors["params.thresholdSek"] = "whole kronor, at least 1";
    }
  } else {
    const atPublish = params.atPublish ?? false;
    const hours = params.hoursBeforeClose ?? null;
    if (typeof atPublish !== "boolean") errors["params.atPublish"] = "must be true or false";
    if (hours !== null && !isInt(hours, 1, MAX_HOURS_BEFORE_CLOSE)) {
      errors["params.hoursBeforeClose"] = `whole hours, 1 to ${String(MAX_HOURS_BEFORE_CLOSE)}`;
    }
    if (atPublish === false && hours === null)
      errors.params = "choose at publish and/or hours before close";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const base = {
    enabled: enabled as boolean,
    minIntervalDays: minIntervalDays as number,
    template: (template as string).trim(),
  };
  return k === "payment_due"
    ? {
        ok: true,
        value: { ...base, kind: k, params: { thresholdSek: params.thresholdSek as number } },
      }
    : {
        ok: true,
        value: {
          ...base,
          kind: k,
          params: {
            atPublish: (params.atPublish ?? false) as boolean,
            hoursBeforeClose: (params.hoursBeforeClose ?? null) as number | null,
          },
        },
      };
}
