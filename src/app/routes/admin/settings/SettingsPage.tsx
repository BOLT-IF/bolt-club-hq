import { useEffect, useState, type SyntheticEvent } from "react";

import { ApiError, apiFetch } from "../../../api/client";
import { Button } from "../../../components/ui/Button";
import { ErrorState, Skeleton } from "../../../components/ui/States";
import { useToast } from "../../../components/ui/Toast";
import { cx } from "../../../lib/cx";
import "./settings.css";

/** Shape of GET/PUT /api/v1/admin/settings (src/worker/settings/model.ts). */
interface Settings {
  clubName: string;
  bank: {
    accountHolder?: string;
    bankName?: string;
    accountNumber?: string;
    iban?: string;
    bankgiro?: string;
  } | null;
  paymentInstructions: string | null;
  quietHours: { start: string; end: string } | null;
  autoPromoteCutoffMin: number;
  clubFeeFallSek?: number;
  clubFeeSpringSek?: number;
  defaults: Record<string, number>;
  accountCodes: Record<string, string>;
  rosterAppUrl: string | null;
}

type Form = Record<string, string>;

const DEFAULT_FIELDS = [
  ["capacity", "Default Capacity (Players)", "16"],
  ["durationMin", "Default Session Length (Minutes)", "90"],
  ["passPrice", "Default Pass Price (kr)", "1200"],
  ["adhocFee", "Default Drop-In Fee (kr)", "120"],
  ["maxGuestsDefault", "Default Guests Per Member", "2"],
  ["rsvpCloseOffsetMin", "RSVP Closes Before Start (Minutes)", "60"],
] as const;

const CODE_FIELDS = [
  ["pass", "Passes", "3010"],
  ["adhoc", "Drop-In Fees", "3011"],
  ["guest", "Guest Fees", "3012"],
  ["payment", "Payments", "1930"],
] as const;

function toForm(s: Settings): Form {
  const form: Form = {
    clubName: s.clubName,
    accountHolder: s.bank?.accountHolder ?? "",
    bankName: s.bank?.bankName ?? "",
    accountNumber: s.bank?.accountNumber ?? "",
    iban: s.bank?.iban ?? "",
    bankgiro: s.bank?.bankgiro ?? "",
    paymentInstructions: s.paymentInstructions ?? "",
    quietStart: s.quietHours?.start ?? "",
    quietEnd: s.quietHours?.end ?? "",
    autoPromoteCutoffMin: String(s.autoPromoteCutoffMin),
    clubFeeFallSek: String(s.clubFeeFallSek ?? 160),
    clubFeeSpringSek: String(s.clubFeeSpringSek ?? 85),
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
    ...(blank(f.bankName) ? {} : { bankName: f.bankName }),
    ...(blank(f.accountNumber) ? {} : { accountNumber: f.accountNumber }),
    ...(blank(f.iban) ? {} : { iban: f.iban }),
    ...(blank(f.bankgiro) ? {} : { bankgiro: f.bankgiro }),
  };
  return {
    clubName: f.clubName,
    bank: Object.keys(bank).length > 0 ? bank : null,
    paymentInstructions: blank(f.paymentInstructions) ? null : f.paymentInstructions,
    quietHours:
      blank(f.quietStart) && blank(f.quietEnd) ? null : { start: f.quietStart, end: f.quietEnd },
    autoPromoteCutoffMin: num(f.autoPromoteCutoffMin),
    clubFeeFallSek: num(f.clubFeeFallSek),
    clubFeeSpringSek: num(f.clubFeeSpringSek),
    defaults,
    accountCodes,
    rosterAppUrl: blank(f.rosterAppUrl) ? null : f.rosterAppUrl,
  };
}

/** Maps API error paths ("bank.iban") to form keys. */
const ERROR_KEY: Record<string, string> = {
  "bank.accountHolder": "accountHolder",
  "bank.bankName": "bankName",
  "bank.accountNumber": "accountNumber",
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
  const [savedForm, setSavedForm] = useState<Form | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "forbidden" | "error">("loading");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Settings>("/admin/settings")
      .then((s) => {
        if (cancelled) return;
        const initial = toForm(s);
        setForm(initial);
        setSavedForm(initial);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus(e instanceof ApiError && e.status === 403 ? "forbidden" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [loadKey]);

  if (status === "loading") return <Skeleton lines={6} label="Loading settings" />;
  if (status === "forbidden") {
    return (
      <section className="bcq-state bcq-state--empty">
        <h1 className="bcq-state__title">Admins Only</h1>
        <p className="bcq-state__body">You need admin access to see this page.</p>
      </section>
    );
  }
  if (status === "error" || !form) {
    return (
      <ErrorState
        onRetry={() => {
          setStatus("loading");
          setLoadKey((k) => k + 1);
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
      const updated = toForm(saved);
      setForm(updated);
      setSavedForm(updated);
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

  const isDirty = savedForm !== null && JSON.stringify(form) !== JSON.stringify(savedForm);

  const field = (
    key: string,
    label: string,
    props: {
      type?: string;
      inputMode?: "numeric" | "text" | "url";
      hint?: string;
      placeholder?: string;
      mono?: boolean;
      tabular?: boolean;
    } = {},
  ) => {
    const id = `settings-${key}`;
    const error = errors[key];
    const describedBy = [error ? `${id}-error` : null, props.hint ? `${id}-hint` : null]
      .filter(Boolean)
      .join(" ");
    const isTime = props.type === "time";

    return (
      <div className="bcq-settings-field" key={key}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          name={key}
          type={props.type ?? "text"}
          inputMode={props.inputMode}
          placeholder={props.placeholder}
          className={cx(
            props.mono && "bcq-settings-input--mono",
            (props.tabular || isTime || props.inputMode === "numeric") &&
              "bcq-settings-input--tabular",
          )}
          value={form[key] ?? ""}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy || undefined}
          autoComplete="off"
          onChange={(e) => {
            set(key, e.target.value);
          }}
        />
        {props.hint ? (
          <p id={`${id}-hint`} className="bcq-settings-field__hint">
            {props.hint}
          </p>
        ) : null}
        {error ? (
          <p id={`${id}-error`} className="bcq-settings-field__error">
            {error}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <section className="bcq-page bcq-settings-page" aria-labelledby="settings-title">
      <div className="bcq-settings-head">
        <h1 id="settings-title" className="bcq-page__title">
          Club Settings
        </h1>
        {isDirty ? <span className="bcq-settings-dirty-pill">Unsaved changes</span> : null}
      </div>

      <form className="bcq-settings" onSubmit={(e) => void onSubmit(e)} noValidate>
        <section className="bcq-settings-section" aria-labelledby="settings-sec-club">
          <h2 id="settings-sec-club" className="bcq-settings-section__label">
            Club
          </h2>
          <div className="bcq-card bcq-settings-card">
            {field("clubName", "Club Name", { placeholder: "BOLT IF" })}
            {field("rosterAppUrl", "Roster App URL", {
              type: "url",
              inputMode: "url",
              placeholder: "https://",
              hint: "Leave empty to hide the roster button",
            })}
          </div>
        </section>

        <section className="bcq-settings-section" aria-labelledby="settings-sec-bank">
          <h2 id="settings-sec-bank" className="bcq-settings-section__label">
            Bank Details
          </h2>
          <div className="bcq-card bcq-settings-card">
            {errors.bank ? <p className="bcq-settings-field__error">{errors.bank}</p> : null}
            {field("accountHolder", "Account Holder", { placeholder: "BOLT IF" })}
            {field("bankName", "Bank Name", { placeholder: "Swedbank" })}
            {field("accountNumber", "Account Number", {
              placeholder: "8327-9 123 456 789-0",
              mono: true,
              tabular: true,
              hint: "Clearing and account number for direct bank transfers",
            })}
            {field("bankgiro", "Bankgiro (Optional)", {
              inputMode: "numeric",
              placeholder: "5402-9681",
              mono: true,
              tabular: true,
            })}
            {field("iban", "IBAN (Optional)", {
              placeholder: "SE45 5000 0000 0583 9825 7466",
              mono: true,
              tabular: true,
            })}
            <div className="bcq-settings-field">
              <label htmlFor="settings-paymentInstructions">Payment Instructions</label>
              <textarea
                id="settings-paymentInstructions"
                rows={3}
                placeholder="Include your payment reference or full name in the transfer message"
                value={form.paymentInstructions ?? ""}
                aria-invalid={errors.paymentInstructions ? "true" : undefined}
                onChange={(e) => {
                  set("paymentInstructions", e.target.value);
                }}
              />
              {errors.paymentInstructions ? (
                <p className="bcq-settings-field__error">{errors.paymentInstructions}</p>
              ) : null}
            </div>
          </div>
        </section>

        <section className="bcq-settings-section" aria-labelledby="settings-sec-rules">
          <h2 id="settings-sec-rules" className="bcq-settings-section__label">
            Rules
          </h2>
          <div className="bcq-card bcq-settings-card">
            {field("autoPromoteCutoffMin", "Stop Waitlist Auto-Promotion (Minutes Before Start)", {
              inputMode: "numeric",
              placeholder: "180",
            })}
            <div className="bcq-settings-grid-group">
              <div className="bcq-settings-grid-2">
                {field("quietStart", "Quiet Hours Start", { type: "time" })}
                {field("quietEnd", "Quiet Hours End", { type: "time" })}
              </div>
              <p className="bcq-settings-field__hint">Push messages wait until quiet hours end</p>
            </div>
          </div>
        </section>

        <section className="bcq-settings-section" aria-labelledby="settings-sec-fees">
          <h2 id="settings-sec-fees" className="bcq-settings-section__label">
            Club Fees
          </h2>
          <div className="bcq-card bcq-settings-card">
            <div className="bcq-settings-grid-group">
              <div className="bcq-settings-grid-2">
                {field("clubFeeFallSek", "Fall Club Fee (kr)", {
                  inputMode: "numeric",
                  placeholder: "160",
                })}
                {field("clubFeeSpringSek", "Spring Joining Fee (kr)", {
                  inputMode: "numeric",
                  placeholder: "85",
                })}
              </div>
              <p className="bcq-settings-field__hint">
                Fall fee is charged once per membership year (Fall–Spring); Spring fee applies only
                to Spring joiners who did not pay in Fall.
              </p>
            </div>
          </div>
        </section>

        <section className="bcq-settings-section" aria-labelledby="settings-sec-defaults">
          <h2 id="settings-sec-defaults" className="bcq-settings-section__label">
            Defaults For New Series
          </h2>
          <div className="bcq-card bcq-settings-card">
            <div className="bcq-settings-grid-2">
              {DEFAULT_FIELDS.map(([key, label, placeholder]) =>
                field(`default.${key}`, label, {
                  inputMode: "numeric",
                  placeholder,
                  tabular: true,
                }),
              )}
            </div>
          </div>
        </section>

        <section className="bcq-settings-section" aria-labelledby="settings-sec-codes">
          <h2 id="settings-sec-codes" className="bcq-settings-section__label">
            Accounting Codes
          </h2>
          <div className="bcq-card bcq-settings-card">
            <div className="bcq-settings-grid-2">
              {CODE_FIELDS.map(([key, label, placeholder]) =>
                field(`code.${key}`, label, {
                  inputMode: "numeric",
                  placeholder,
                  mono: true,
                  tabular: true,
                }),
              )}
            </div>
          </div>
        </section>

        <div className="bcq-settings-actions">
          <Button type="submit" block disabled={saving}>
            {saving ? "Saving…" : "Save Settings"}
          </Button>
        </div>
      </form>
    </section>
  );
}
