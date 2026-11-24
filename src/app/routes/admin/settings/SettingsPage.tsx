import { useEffect, useState, type SyntheticEvent } from "react";

import { ApiError, apiFetch } from "../../../api/client";
import { Button } from "../../../components/ui/Button";
import { ErrorState, Skeleton } from "../../../components/ui/States";
import { useToast } from "../../../components/ui/Toast";
import "./settings.css";

/** Shape of GET/PUT /api/v1/admin/settings (src/worker/settings/model.ts). */
interface Settings {
  clubName: string;
  bank: { accountHolder?: string; iban?: string; bankgiro?: string } | null;
  paymentInstructions: string | null;
  quietHours: { start: string; end: string } | null;
  passUnpaidRevokeDays: number;
  autoPromoteCutoffMin: number;
  defaults: Record<string, number>;
  accountCodes: Record<string, string>;
  rosterAppUrl: string | null;
}

type Form = Record<string, string>;

const DEFAULT_FIELDS = [
  ["capacity", "Default capacity (players)"],
  ["durationMin", "Default session length (minutes)"],
  ["passPrice", "Default pass price (kr)"],
  ["adhocFee", "Default drop-in fee (kr)"],
  ["maxGuestsDefault", "Default guests per member"],
  ["rsvpCloseOffsetMin", "RSVP closes before start (minutes)"],
] as const;

const CODE_FIELDS = [
  ["pass", "Passes"],
  ["adhoc", "Drop-in fees"],
  ["guest", "Guest fees"],
  ["payment", "Payments"],
] as const;

function toForm(s: Settings): Form {
  const form: Form = {
    clubName: s.clubName,
    accountHolder: s.bank?.accountHolder ?? "",
    iban: s.bank?.iban ?? "",
    bankgiro: s.bank?.bankgiro ?? "",
    paymentInstructions: s.paymentInstructions ?? "",
    quietStart: s.quietHours?.start ?? "",
    quietEnd: s.quietHours?.end ?? "",
    passUnpaidRevokeDays: String(s.passUnpaidRevokeDays),
    autoPromoteCutoffMin: String(s.autoPromoteCutoffMin),
    rosterAppUrl: s.rosterAppUrl ?? "",
  };
  for (const [key] of DEFAULT_FIELDS) form[`default.${key}`] = String(s.defaults[key] ?? "");
  for (const [key] of CODE_FIELDS) form[`code.${key}`] = s.accountCodes[key] ?? "";
  return form;
}

const blank = (v: string | undefined): boolean => (v ?? "").trim() === "";
/** Numbers go to the API as numbers; unparseable text goes as-is so the server rejects it. */
const num = (v: string | undefined): number | string =>
  Number.isNaN(Number(v)) ? (v ?? "") : Number(v);

function toBody(f: Form): unknown {
  const defaults: Record<string, number | string> = {};
  for (const [key] of DEFAULT_FIELDS) {
    const v = f[`default.${key}`];
    if (!blank(v)) defaults[key] = num(v);
  }
  const accountCodes: Record<string, string> = {};
  for (const [key] of CODE_FIELDS) {
    const v = f[`code.${key}`];
    if (!blank(v)) accountCodes[key] = (v ?? "").trim();
  }
  const bank = {
    ...(blank(f.accountHolder) ? {} : { accountHolder: f.accountHolder }),
    ...(blank(f.iban) ? {} : { iban: f.iban }),
    ...(blank(f.bankgiro) ? {} : { bankgiro: f.bankgiro }),
  };
  return {
    clubName: f.clubName,
    bank: Object.keys(bank).length > 0 ? bank : null,
    paymentInstructions: blank(f.paymentInstructions) ? null : f.paymentInstructions,
    quietHours:
      blank(f.quietStart) && blank(f.quietEnd) ? null : { start: f.quietStart, end: f.quietEnd },
    passUnpaidRevokeDays: num(f.passUnpaidRevokeDays),
    autoPromoteCutoffMin: num(f.autoPromoteCutoffMin),
    defaults,
    accountCodes,
    rosterAppUrl: blank(f.rosterAppUrl) ? null : f.rosterAppUrl,
  };
}

/** Maps API error paths ("bank.iban") to form keys. */
const ERROR_KEY: Record<string, string> = {
  "bank.accountHolder": "accountHolder",
  "bank.iban": "iban",
  "bank.bankgiro": "bankgiro",
  "quietHours.start": "quietStart",
  "quietHours.end": "quietEnd",
};
const formKey = (path: string): string =>
  ERROR_KEY[path] ??
  (path.startsWith("defaults.") ? `default.${path.slice(9)}` : null) ??
  (path.startsWith("accountCodes.") ? `code.${path.slice(13)}` : path);

export default function SettingsPage() {
  const toast = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "forbidden" | "error">("loading");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Settings>("/admin/settings")
      .then((s) => {
        if (cancelled) return;
        setForm(toForm(s));
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus(e instanceof ApiError && e.status === 403 ? "forbidden" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "loading") return <Skeleton lines={6} label="Loading settings" />;
  if (status === "forbidden") {
    return (
      <section className="bcq-state bcq-state--empty">
        <h1 className="bcq-state__title">Admins only</h1>
        <p className="bcq-state__body">You need admin access to see this page.</p>
      </section>
    );
  }
  if (status === "error" || !form) {
    return (
      <ErrorState
        onRetry={() => {
          window.location.reload();
        }}
      >
        Settings could not be loaded.
      </ErrorState>
    );
  }

  const set = (key: string, value: string) => {
    setForm({ ...form, [key]: value });
  };

  async function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setErrors({});
    try {
      const saved = await apiFetch<Settings>("/admin/settings", {
        method: "PUT",
        body: toBody(form),
      });
      setForm(toForm(saved));
      toast.show("Settings saved", "success");
    } catch (e: unknown) {
      const fields =
        (e instanceof ApiError
          ? (e.body as { fields?: Record<string, string> } | null)?.fields
          : null) ?? null;
      if (fields) {
        setErrors(Object.fromEntries(Object.entries(fields).map(([k, v]) => [formKey(k), v])));
        toast.show("Check the highlighted fields", "danger");
      } else {
        toast.show("Could not save settings", "danger");
      }
    } finally {
      setSaving(false);
    }
  }

  const field = (
    key: string,
    label: string,
    props: {
      type?: string;
      inputMode?: "numeric" | "text" | "url";
      hint?: string;
      placeholder?: string;
    } = {},
  ) => {
    const id = `settings-${key}`;
    const error = errors[key];
    const describedBy = [error ? `${id}-error` : null, props.hint ? `${id}-hint` : null]
      .filter(Boolean)
      .join(" ");
    return (
      <div className="bcq-field" key={key}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          name={key}
          type={props.type ?? "text"}
          inputMode={props.inputMode}
          placeholder={props.placeholder}
          value={form[key] ?? ""}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy || undefined}
          autoComplete="off"
          onChange={(e) => {
            set(key, e.target.value);
          }}
        />
        {props.hint ? (
          <p id={`${id}-hint`} className="bcq-field__hint">
            {props.hint}
          </p>
        ) : null}
        {error ? (
          <p id={`${id}-error`} className="bcq-field__error">
            {error}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <section className="bcq-page" aria-labelledby="settings-title">
      <h1 id="settings-title" className="bcq-page__title">
        Club settings
      </h1>
      <form className="bcq-settings" onSubmit={(e) => void onSubmit(e)} noValidate>
        <fieldset>
          <legend>Club</legend>
          {field("clubName", "Club name")}
          {field("rosterAppUrl", "Roster app URL", {
            type: "url",
            inputMode: "url",
            placeholder: "https://",
            hint: "Leave empty to hide the roster button.",
          })}
        </fieldset>

        <fieldset>
          <legend>Bank details</legend>
          {field("accountHolder", "Account holder")}
          {field("iban", "IBAN", { placeholder: "SE45 5000 0000 0583 9825 7466" })}
          {field("bankgiro", "Bankgiro", { inputMode: "numeric", placeholder: "5402-9681" })}
          <div className="bcq-field">
            <label htmlFor="settings-paymentInstructions">Payment instructions</label>
            <textarea
              id="settings-paymentInstructions"
              rows={3}
              value={form.paymentInstructions ?? ""}
              aria-invalid={errors.paymentInstructions ? "true" : undefined}
              onChange={(e) => {
                set("paymentInstructions", e.target.value);
              }}
            />
            {errors.paymentInstructions ? (
              <p className="bcq-field__error">{errors.paymentInstructions}</p>
            ) : null}
          </div>
        </fieldset>

        <fieldset>
          <legend>Rules</legend>
          {field("passUnpaidRevokeDays", "Days before an unpaid pass can be revoked", {
            inputMode: "numeric",
          })}
          {field(
            "autoPromoteCutoffMin",
            "Stop promoting from the waiting list (minutes before start)",
            { inputMode: "numeric" },
          )}
          {field("quietStart", "Quiet hours start", {
            type: "time",
            hint: "Push messages wait until quiet hours end.",
          })}
          {field("quietEnd", "Quiet hours end", { type: "time" })}
        </fieldset>

        <fieldset>
          <legend>Defaults for new series</legend>
          {DEFAULT_FIELDS.map(([key, label]) =>
            field(`default.${key}`, label, { inputMode: "numeric" }),
          )}
        </fieldset>

        <fieldset>
          <legend>Accounting codes</legend>
          {CODE_FIELDS.map(([key, label]) => field(`code.${key}`, label))}
        </fieldset>

        <Button type="submit" block disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </form>
    </section>
  );
}
