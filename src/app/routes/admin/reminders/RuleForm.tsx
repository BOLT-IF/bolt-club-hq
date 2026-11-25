import { useRef, useState, type SyntheticEvent } from "react";

import { ApiError, newIdempotencyKey } from "../../../api/client";
import { Button, useToast } from "../../../components/ui";
import {
  createReminderRule,
  findUnknownPlaceholders,
  getValidationFields,
  KIND_LABEL,
  updateReminderRule,
  type PlaceholdersMap,
  type ReminderRule,
  type RuleInput,
  type RuleKind,
} from "./remindersApi";

const DEFAULT_INTERVAL: Record<RuleKind, string> = {
  payment_due: "90",
  event_unrsvped: "1",
};

const MAX_TEMPLATE_LENGTH = 500;
const MAX_INTERVAL_DAYS = 366;
const MAX_HOURS_BEFORE_CLOSE = 24 * 14;
const MAX_THRESHOLD_SEK = 1_000_000;

interface FormState {
  kind: RuleKind;
  enabled: boolean;
  minIntervalDays: string;
  thresholdSek: string;
  atPublish: boolean;
  hoursBeforeClose: string;
  template: string;
}

function toForm(rule: ReminderRule | null): FormState {
  if (!rule) {
    return {
      kind: "payment_due",
      enabled: true,
      minIntervalDays: DEFAULT_INTERVAL.payment_due,
      thresholdSek: "",
      atPublish: false,
      hoursBeforeClose: "",
      template: "",
    };
  }
  return {
    kind: rule.kind,
    enabled: rule.enabled,
    minIntervalDays: String(rule.minIntervalDays),
    thresholdSek: rule.kind === "payment_due" ? String(rule.params.thresholdSek) : "",
    atPublish: rule.kind === "event_unrsvped" ? rule.params.atPublish : false,
    hoursBeforeClose:
      rule.kind === "event_unrsvped" && rule.params.hoursBeforeClose !== null
        ? String(rule.params.hoursBeforeClose)
        : "",
    template: rule.template,
  };
}

function parseIntInRange(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function validateForm(
  form: FormState,
  knownPlaceholders: readonly string[],
): { ok: true; value: RuleInput } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const minIntervalDays = parseIntInRange(form.minIntervalDays, 1, MAX_INTERVAL_DAYS);
  if (minIntervalDays === null) {
    errors.minIntervalDays = `Enter whole days from 1 to ${String(MAX_INTERVAL_DAYS)}.`;
  }

  const trimmedTemplate = form.template.trim();
  if (trimmedTemplate === "") {
    errors.template = "Enter a message template.";
  } else if (form.template.length > MAX_TEMPLATE_LENGTH) {
    errors.template = `At most ${String(MAX_TEMPLATE_LENGTH)} characters.`;
  } else {
    const unknown = findUnknownPlaceholders(form.template, knownPlaceholders);
    if (unknown.length > 0) {
      errors.template = `Unknown placeholder: {${unknown.join("}, {")}}`;
    }
  }

  if (form.kind === "payment_due") {
    const thresholdSek = parseIntInRange(form.thresholdSek, 1, MAX_THRESHOLD_SEK);
    if (thresholdSek === null) {
      errors["params.thresholdSek"] = "Enter whole kronor, at least 1.";
    }
    if (Object.keys(errors).length > 0 || minIntervalDays === null || thresholdSek === null) {
      return { ok: false, errors };
    }
    return {
      ok: true,
      value: {
        kind: "payment_due",
        enabled: form.enabled,
        minIntervalDays,
        template: trimmedTemplate,
        params: { thresholdSek },
      },
    };
  }

  const hoursTrimmed = form.hoursBeforeClose.trim();
  let hoursBeforeClose: number | null = null;
  if (hoursTrimmed !== "") {
    hoursBeforeClose = parseIntInRange(hoursTrimmed, 1, MAX_HOURS_BEFORE_CLOSE);
    if (hoursBeforeClose === null) {
      errors["params.hoursBeforeClose"] =
        `Enter whole hours from 1 to ${String(MAX_HOURS_BEFORE_CLOSE)}.`;
    }
  }
  if (!form.atPublish && hoursTrimmed === "") {
    errors.params = "Choose at publish and/or hours before close.";
  }

  if (Object.keys(errors).length > 0 || minIntervalDays === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      kind: "event_unrsvped",
      enabled: form.enabled,
      minIntervalDays,
      template: trimmedTemplate,
      params: { atPublish: form.atPublish, hoursBeforeClose },
    },
  };
}

export function RuleForm({
  initial,
  placeholders,
  onSaved,
  onCancel,
  onForbidden,
}: {
  readonly initial: ReminderRule | null;
  readonly placeholders: PlaceholdersMap;
  readonly onSaved: () => Promise<void>;
  readonly onCancel: () => void;
  readonly onForbidden: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => toForm(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey());
  const templateRef = useRef<HTMLTextAreaElement>(null);

  const knownPlaceholders = placeholders[form.kind];

  const handleKindChange = (nextKind: RuleKind) => {
    setForm((prev) => {
      const prevDefault = DEFAULT_INTERVAL[prev.kind];
      const nextInterval =
        !initial && prev.minIntervalDays === prevDefault
          ? DEFAULT_INTERVAL[nextKind]
          : prev.minIntervalDays;
      return { ...prev, kind: nextKind, minIntervalDays: nextInterval };
    });
    setErrors({});
    setFormError(null);
  };

  const insertPlaceholder = (name: string) => {
    const token = `{${name}}`;
    const el = templateRef.current;
    if (!el) {
      setForm((prev) => ({ ...prev, template: `${prev.template}${token}` }));
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const nextValue = `${form.template.slice(0, start)}${token}${form.template.slice(end)}`;
    setForm((prev) => ({ ...prev, template: nextValue }));
    el.focus();
  };

  const handleSubmit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    const validated = validateForm(form, knownPlaceholders);
    if (!validated.ok) {
      setErrors(validated.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      if (initial) {
        await updateReminderRule(initial.id, validated.value);
        toast.show("Rule updated", "success");
      } else {
        await createReminderRule(validated.value, idempotencyKey);
        setIdempotencyKey(newIdempotencyKey());
        toast.show("Rule created", "success");
      }
      await onSaved();
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 403) {
        onForbidden();
        return;
      }
      const fields = getValidationFields(error);
      if (fields) {
        setErrors(fields);
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        setFormError("This rule was deleted before it could be saved.");
        return;
      }
      setFormError("Could not save the rule. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="bcq-reminder-form"
      aria-labelledby="rule-form-title"
      onSubmit={(e) => void handleSubmit(e)}
      noValidate
    >
      <h2 id="rule-form-title" className="bcq-reminder-form__title">
        {initial ? "Edit reminder rule" : "New reminder rule"}
      </h2>

      <div className="bcq-reminder-field">
        <label htmlFor="rule-kind">Rule kind</label>
        <select
          id="rule-kind"
          value={form.kind}
          onChange={(e) => {
            handleKindChange(e.target.value as RuleKind);
          }}
        >
          {(["payment_due", "event_unrsvped"] as const).map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABEL[kind]}
            </option>
          ))}
        </select>
      </div>

      <label className="bcq-reminder-check">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => {
            setForm((prev) => ({ ...prev, enabled: e.target.checked }));
          }}
        />
        Enabled
      </label>

      {form.kind === "payment_due" ? (
        <div className="bcq-reminder-field">
          <label htmlFor="rule-threshold">Minimum balance owed (kr)</label>
          <input
            id="rule-threshold"
            inputMode="numeric"
            value={form.thresholdSek}
            aria-invalid={errors["params.thresholdSek"] ? "true" : undefined}
            aria-describedby={errors["params.thresholdSek"] ? "rule-threshold-error" : undefined}
            onChange={(e) => {
              setForm((prev) => ({ ...prev, thresholdSek: e.target.value }));
            }}
          />
          {errors["params.thresholdSek"] ? (
            <p id="rule-threshold-error" className="bcq-reminder-field__error">
              {errors["params.thresholdSek"]}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <label className="bcq-reminder-check">
            <input
              type="checkbox"
              checked={form.atPublish}
              onChange={(e) => {
                setForm((prev) => ({ ...prev, atPublish: e.target.checked }));
              }}
            />
            Remind when event opens (within 7 days of start)
          </label>
          <div className="bcq-reminder-field">
            <label htmlFor="rule-hours">Hours before RSVP closes (optional)</label>
            <input
              id="rule-hours"
              inputMode="numeric"
              value={form.hoursBeforeClose}
              aria-invalid={errors["params.hoursBeforeClose"] ? "true" : undefined}
              aria-describedby={
                errors["params.hoursBeforeClose"] ? "rule-hours-error" : "rule-hours-hint"
              }
              onChange={(e) => {
                setForm((prev) => ({ ...prev, hoursBeforeClose: e.target.value }));
              }}
            />
            <p id="rule-hours-hint" className="bcq-reminder-field__hint">
              Leave blank to skip the pre-close reminder.
            </p>
            {errors["params.hoursBeforeClose"] ? (
              <p id="rule-hours-error" className="bcq-reminder-field__error">
                {errors["params.hoursBeforeClose"]}
              </p>
            ) : null}
          </div>
          {errors.params ? (
            <p role="alert" className="bcq-reminder-field__error">
              {errors.params}
            </p>
          ) : null}
        </>
      )}

      <div className="bcq-reminder-field">
        <label htmlFor="rule-interval">Minimum days between reminders</label>
        <input
          id="rule-interval"
          inputMode="numeric"
          value={form.minIntervalDays}
          aria-invalid={errors.minIntervalDays ? "true" : undefined}
          aria-describedby={errors.minIntervalDays ? "rule-interval-error" : undefined}
          onChange={(e) => {
            setForm((prev) => ({ ...prev, minIntervalDays: e.target.value }));
          }}
        />
        {errors.minIntervalDays ? (
          <p id="rule-interval-error" className="bcq-reminder-field__error">
            {errors.minIntervalDays}
          </p>
        ) : null}
      </div>

      <div className="bcq-reminder-field">
        <label htmlFor="rule-template">Message template</label>
        <textarea
          ref={templateRef}
          id="rule-template"
          rows={4}
          maxLength={MAX_TEMPLATE_LENGTH}
          value={form.template}
          aria-invalid={errors.template ? "true" : undefined}
          aria-describedby={errors.template ? "rule-template-error" : "rule-placeholders-help"}
          onChange={(e) => {
            setForm((prev) => ({ ...prev, template: e.target.value }));
          }}
        />
        {errors.template ? (
          <p id="rule-template-error" role="alert" className="bcq-reminder-field__error">
            {errors.template}
          </p>
        ) : null}
      </div>

      <div className="bcq-placeholders" id="rule-placeholders-help">
        <p className="bcq-placeholders__label">Available placeholders (tap to insert):</p>
        <div className="bcq-placeholders__list">
          {knownPlaceholders.map((name) => (
            <button
              key={name}
              type="button"
              className="bcq-placeholder-chip"
              onClick={() => {
                insertPlaceholder(name);
              }}
            >
              {`{${name}}`}
            </button>
          ))}
        </div>
      </div>

      {formError ? (
        <p role="alert" className="bcq-reminder-field__error">
          {formError}
        </p>
      ) : null}

      <div className="bcq-reminder-form__actions">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save rule"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
