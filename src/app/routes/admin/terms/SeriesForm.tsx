import { useRef, useState } from "react";

import { BottomSheet, Button } from "../../../components/ui";
import { cx } from "../../../lib/cx";
import {
  FORMATS,
  FORMAT_LABEL,
  SelectField,
  TextField,
  WEEKDAYS,
  toWhole,
  type SeriesRow,
} from "./shared";

export type SeriesValues = Pick<
  SeriesRow,
  | "name"
  | "format"
  | "weekday"
  | "startTime"
  | "durationMin"
  | "location"
  | "capacity"
  | "passPrice"
  | "adhocFee"
  | "maxGuestsDefault"
  | "rsvpCloseOffsetMin"
>;

interface FormState {
  name: string;
  format: string;
  weekday: string;
  startTime: string;
  durationMin: string;
  location: string;
  capacity: string;
  passPrice: string;
  discountedPassPrice: string;
  adhocFee: string;
  maxGuestsDefault: string;
  rsvpCloseOffsetMin: string;
}

const EMPTY: FormState = {
  name: "",
  format: "open",
  weekday: "1",
  startTime: "",
  durationMin: "",
  location: "",
  capacity: "",
  passPrice: "",
  discountedPassPrice: "",
  adhocFee: "",
  maxGuestsDefault: "1",
  rsvpCloseOffsetMin: "1440",
};

function fromSeries(s: SeriesRow): FormState {
  return {
    name: s.name,
    format: s.format,
    weekday: String(s.weekday),
    startTime: s.startTime,
    durationMin: String(s.durationMin),
    location: s.location ?? "",
    capacity: String(s.capacity),
    passPrice: String(s.passPrice),
    discountedPassPrice: s.discountedPassPrice === null ? "" : String(s.discountedPassPrice),
    adhocFee: String(s.adhocFee),
    maxGuestsDefault: String(s.maxGuestsDefault),
    rsvpCloseOffsetMin: String(s.rsvpCloseOffsetMin),
  };
}

/** The fields whose value differs from `base`, as an API body (whole kronor, whole minutes). */
function diff(form: FormState, base: FormState): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const numeric = [
    "weekday",
    "durationMin",
    "capacity",
    "passPrice",
    "adhocFee",
    "maxGuestsDefault",
    "rsvpCloseOffsetMin",
  ] as const;
  for (const key of ["name", "format", "startTime"] as const) {
    if (form[key] !== base[key]) out[key] = form[key].trim();
  }
  if (form.location !== base.location) out.location = form.location.trim() || null;
  for (const key of numeric) {
    if (form[key] === base[key]) continue;
    const n = toWhole(form[key]);
    if (n === null) return null;
    out[key] = n;
  }
  if (form.discountedPassPrice !== base.discountedPassPrice) {
    const trimmed = form.discountedPassPrice.trim();
    if (trimmed === "") {
      out.discountedPassPrice = null;
    } else {
      const n = toWhole(trimmed);
      if (n === null) return null;
      out.discountedPassPrice = n;
    }
  }
  return out;
}

export function SeriesFormSheet({
  open,
  title,
  initial,
  submitLabel,
  eligibleCandidates,
  onClose,
  onSubmit,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly initial?: SeriesRow;
  readonly submitLabel: string;
  readonly eligibleCandidates?: ReadonlyArray<{
    readonly id: string;
    readonly displayName: string;
  }>;
  /** Receives only the changed fields (all of them when creating). Throw to keep the sheet open. */
  readonly onSubmit: (changes: Record<string, unknown>) => Promise<void>;
  readonly onClose: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const base = initial ? fromSeries(initial) : EMPTY;
  const [form, setForm] = useState<FormState>(base);
  const [pickedEligible, setPickedEligible] = useState<ReadonlySet<string>>(() => new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof FormState) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  async function runSubmit() {
    if (formRef.current?.reportValidity() === false) return;
    const changes = diff(form, base);
    if (changes === null) {
      setProblem("Prices, capacity, and times must be whole numbers.");
      return;
    }
    const effectivePassPrice = toWhole(form.passPrice);
    const effectiveDiscount =
      form.discountedPassPrice.trim() === "" ? null : toWhole(form.discountedPassPrice);
    if (
      effectivePassPrice !== null &&
      effectiveDiscount !== null &&
      effectiveDiscount > effectivePassPrice
    ) {
      setProblem("Discounted pass price cannot exceed the regular pass price.");
      return;
    }
    if (initial && Object.keys(changes).length === 0) {
      setProblem("Nothing to save yet.");
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const payload =
        !initial && pickedEligible.size > 0
          ? { ...changes, discountEligibleIds: [...pickedEligible] }
          : changes;
      await onSubmit(payload);
      if (!initial) {
        setForm(EMPTY);
        setPickedEligible(new Set());
      }
      onClose();
    } catch {
      // Errors are toasted by the caller; keep the sheet open.
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className="bcq-terms-sheet-footer">
          <Button type="button" disabled={busy} onClick={() => void runSubmit()}>
            {submitLabel}
          </Button>
          <Button
            type="button"
            variant="tonal"
            disabled={busy}
            onClick={() => {
              if (!busy) onClose();
            }}
          >
            Cancel
          </Button>
        </div>
      }
    >
      <form
        ref={formRef}
        className="bcq-form"
        onSubmit={(e) => {
          e.preventDefault();
          void runSubmit();
        }}
        noValidate={false}
      >
        <TextField
          label="Name"
          placeholder="e.g. Sunday Social MD"
          value={form.name}
          onChange={set("name")}
          required
        />
        <div className="bcq-terms-grid-2">
          <SelectField
            label="Format"
            value={form.format}
            onChange={set("format")}
            options={FORMATS.map((f) => ({ value: f, label: FORMAT_LABEL[f] ?? f }))}
          />
          <SelectField
            label="Weekday"
            value={form.weekday}
            onChange={set("weekday")}
            options={WEEKDAYS.map((label, i) => ({ value: String(i + 1), label }))}
          />
        </div>
        <div className="bcq-terms-grid-2">
          <TextField
            label="Start Time"
            type="time"
            value={form.startTime}
            onChange={set("startTime")}
            required
          />
          <TextField
            label="Duration (Minutes)"
            type="number"
            placeholder="90"
            value={form.durationMin}
            onChange={set("durationMin")}
            required
          />
        </div>
        <TextField
          label="Location"
          placeholder="e.g. Sollentuna Rackethall"
          value={form.location}
          onChange={set("location")}
        />
        <div className="bcq-terms-grid-2">
          <TextField
            label="Capacity"
            type="number"
            placeholder="20"
            value={form.capacity}
            onChange={set("capacity")}
            required
          />
          <TextField
            label="Pass Price (kr)"
            type="number"
            placeholder="1350"
            value={form.passPrice}
            onChange={set("passPrice")}
            required
          />
        </div>
        <div className="bcq-terms-grid-2">
          <TextField
            label="Discounted Price (kr, Optional)"
            type="number"
            placeholder="Optional"
            value={form.discountedPassPrice}
            onChange={set("discountedPassPrice")}
          />
          <TextField
            label="Drop-In Fee (kr)"
            type="number"
            placeholder="85"
            value={form.adhocFee}
            onChange={set("adhocFee")}
            required
          />
        </div>
        <div className="bcq-terms-grid-2">
          <TextField
            label="Guests Per Member"
            type="number"
            placeholder="1"
            value={form.maxGuestsDefault}
            onChange={set("maxGuestsDefault")}
          />
          <TextField
            label="RSVP Closes (Minutes Before Start)"
            type="number"
            placeholder="1440"
            value={form.rsvpCloseOffsetMin}
            onChange={set("rsvpCloseOffsetMin")}
          />
        </div>

        {!initial && eligibleCandidates && eligibleCandidates.length > 0 ? (
          <div className="bcq-terms-field">
            <span id="add-series-eligible-label" className="bcq-terms-field__label">
              Eligible for Discounted Rate (Optional)
            </span>
            <div
              className="bcq-eligible-chips"
              role="group"
              aria-labelledby="add-series-eligible-label"
            >
              {eligibleCandidates.map((m) => {
                const selected = pickedEligible.has(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={selected}
                    className={cx("bcq-eligible-chip", selected && "is-selected")}
                    onClick={() => {
                      setPickedEligible((current) => {
                        const next = new Set(current);
                        if (next.has(m.id)) next.delete(m.id);
                        else next.add(m.id);
                        return next;
                      });
                    }}
                  >
                    {m.displayName}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {problem ? (
          <p role="status" className="bcq-terms-field__hint">
            {problem}
          </p>
        ) : null}
      </form>
    </BottomSheet>
  );
}
