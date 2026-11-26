import {
  DEFAULT_KEYS,
  type BankDetails,
  type ClubSettingsValue,
  type DefaultKey,
  type QuietHours,
} from "./model";

export type FieldErrors = Record<string, string>;
export type ValidationResult =
  { ok: true; value: ClubSettingsValue } | { ok: false; errors: FieldErrors };

export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/** ISO 13616 mod-97 check, plus the fixed length of 24 for Sweden. */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.startsWith("SE") && iban.length !== 24) return false;
  let remainder = 0;
  for (const ch of iban.slice(4) + iban.slice(0, 4)) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

function luhn(digits: string): boolean {
  let sum = 0;
  digits
    .split("")
    .reverse()
    .forEach((d, i) => {
      let n = Number(d);
      if (i % 2 === 1) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
    });
  return sum % 10 === 0;
}

/** "5402-9681" form: the last four digits after a hyphen. */
export function normalizeBankgiro(raw: string): string {
  const digits = raw.replace(/[\s-]/g, "");
  return `${digits.slice(0, -4)}-${digits.slice(-4)}`;
}

/** Bankgiro numbers have 7 or 8 digits and a Luhn check digit. */
export function isValidBankgiro(raw: string): boolean {
  return /^\d{3,4}-?\d{4}$/.test(raw.trim()) && luhn(raw.replace(/[\s-]/g, ""));
}

export function normalizeAccountNumber(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Swedish clearing + account number: 5–30 digits with optional spaces or hyphens. */
export function isValidAccountNumber(raw: string): boolean {
  const normalized = normalizeAccountNumber(raw);
  if (normalized.length > 40 || !/^[0-9][0-9 -]*[0-9]$/.test(normalized)) return false;
  const digits = normalized.replace(/[^0-9]/g, "");
  return digits.length >= 5 && digits.length <= 30;
}

/** https only, no credentials, query or fragment (the app appends `/planner#import=…`). */
export function normalizeRosterAppUrl(raw: string): { ok: true; value: string } | { ok: false } {
  const text = raw.trim();
  if (text.includes("?") || text.includes("#")) return { ok: false };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    return { ok: false };
  }
  return { ok: true, value: url.origin + url.pathname.replace(/\/+$/, "") };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const CODE_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const CODE_VALUE = /^[A-Za-z0-9._-]{1,20}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isBlank = (v: unknown): boolean => v === undefined || v === null || v === "";

function text(v: unknown, max: number): string | null | undefined {
  if (isBlank(v)) return null;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (trimmed.length > max) return undefined;
  return trimmed === "" ? null : trimmed;
}

function wholeNumber(v: unknown, min: number, max: number): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

/** Validates and normalises a PUT body. Errors are keyed by dotted field path. */
export function validateSettingsInput(input: unknown): ValidationResult {
  if (!isRecord(input)) return { ok: false, errors: { body: "Send a JSON object" } };
  const errors: FieldErrors = {};

  const clubName = text(input.clubName, 80);
  if (!clubName) errors.clubName = "Enter the club name (up to 80 characters)";

  const paymentInstructions = text(input.paymentInstructions, 1000);
  if (paymentInstructions === undefined) {
    errors.paymentInstructions = "Use text of up to 1000 characters";
  }

  const bank = validateBank(input.bank, errors);
  const quietHours = validateQuietHours(input.quietHours, errors);

  const passUnpaidRevokeDays = wholeNumber(input.passUnpaidRevokeDays, 1, 365);
  if (passUnpaidRevokeDays === undefined) {
    errors.passUnpaidRevokeDays = "Enter a whole number of days from 1 to 365";
  }
  const autoPromoteCutoffMin = wholeNumber(input.autoPromoteCutoffMin, 0, 10080);
  if (autoPromoteCutoffMin === undefined) {
    errors.autoPromoteCutoffMin = "Enter a whole number of minutes from 0 to 10080";
  }

  const defaults = validateDefaults(input.defaults, errors);
  const accountCodes = validateAccountCodes(input.accountCodes, errors);

  let rosterAppUrl: string | null = null;
  if (!isBlank(input.rosterAppUrl)) {
    const parsed =
      typeof input.rosterAppUrl === "string"
        ? normalizeRosterAppUrl(input.rosterAppUrl)
        : ({ ok: false } as const);
    if (parsed.ok) rosterAppUrl = parsed.value;
    else errors.rosterAppUrl = "Enter an https:// address without a query or #fragment";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      clubName: clubName as string,
      bank: bank ?? null,
      paymentInstructions: paymentInstructions ?? null,
      quietHours: quietHours ?? null,
      passUnpaidRevokeDays: passUnpaidRevokeDays as number,
      autoPromoteCutoffMin: autoPromoteCutoffMin as number,
      defaults,
      accountCodes,
      rosterAppUrl,
    },
  };
}

function validateBank(v: unknown, errors: FieldErrors): BankDetails | null {
  if (isBlank(v)) return null;
  if (!isRecord(v)) {
    errors.bank = "Send the bank details as an object";
    return null;
  }
  const bank: BankDetails = {};
  const holder = text(v.accountHolder, 80);
  if (holder === undefined) errors["bank.accountHolder"] = "Use up to 80 characters";
  else if (holder) bank.accountHolder = holder;

  const bankName = text(v.bankName, 80);
  if (bankName === undefined) errors["bank.bankName"] = "Use up to 80 characters";
  else if (bankName) bank.bankName = bankName;

  if (!isBlank(v.accountNumber)) {
    if (typeof v.accountNumber === "string" && isValidAccountNumber(v.accountNumber)) {
      bank.accountNumber = normalizeAccountNumber(v.accountNumber);
    } else errors["bank.accountNumber"] = "Enter a valid bank account number";
  }

  if (!isBlank(v.iban)) {
    if (typeof v.iban === "string" && isValidIban(v.iban)) bank.iban = normalizeIban(v.iban);
    else errors["bank.iban"] = "Enter a valid IBAN";
  }
  if (!isBlank(v.bankgiro)) {
    if (typeof v.bankgiro === "string" && isValidBankgiro(v.bankgiro)) {
      bank.bankgiro = normalizeBankgiro(v.bankgiro);
    } else errors["bank.bankgiro"] = "Enter a valid bankgiro number, like 5402-9681";
  }
  if (
    !bank.accountNumber &&
    !bank.bankgiro &&
    !bank.iban &&
    !errors["bank.accountNumber"] &&
    !errors["bank.bankgiro"] &&
    !errors["bank.iban"]
  ) {
    errors.bank = "Enter a bank account number, bankgiro, or IBAN";
  }
  return bank;
}

function validateQuietHours(v: unknown, errors: FieldErrors): QuietHours | null {
  if (isBlank(v)) return null;
  if (!isRecord(v)) {
    errors.quietHours = "Send quiet hours as start and end times";
    return null;
  }
  const { start, end } = v;
  const startOk = typeof start === "string" && TIME.test(start);
  const endOk = typeof end === "string" && TIME.test(end);
  if (!startOk) errors["quietHours.start"] = "Use a 24-hour time like 22:00";
  if (!endOk) errors["quietHours.end"] = "Use a 24-hour time like 08:00";
  if (startOk && endOk && start === end) {
    errors["quietHours.end"] = "End must differ from start";
  }
  return startOk && endOk ? { start, end } : null;
}

const DEFAULT_RANGES: Record<DefaultKey, [number, number]> = {
  capacity: [1, 200],
  durationMin: [1, 1440],
  passPrice: [0, 100000],
  adhocFee: [0, 100000],
  maxGuestsDefault: [0, 20],
  rsvpCloseOffsetMin: [0, 20160],
};

function validateDefaults(v: unknown, errors: FieldErrors): ClubSettingsValue["defaults"] {
  const out: ClubSettingsValue["defaults"] = {};
  if (isBlank(v)) return out;
  if (!isRecord(v)) {
    errors.defaults = "Send the defaults as an object";
    return out;
  }
  for (const [key, value] of Object.entries(v)) {
    if (!(DEFAULT_KEYS as readonly string[]).includes(key)) {
      errors[`defaults.${key}`] = "Unknown default";
      continue;
    }
    if (isBlank(value)) continue;
    const [min, max] = DEFAULT_RANGES[key as DefaultKey];
    const n = wholeNumber(value, min, max);
    if (n === undefined)
      errors[`defaults.${key}`] = `Enter a whole number from ${String(min)} to ${String(max)}`;
    else out[key as DefaultKey] = n;
  }
  return out;
}

function validateAccountCodes(v: unknown, errors: FieldErrors): Record<string, string> {
  const out: Record<string, string> = {};
  if (isBlank(v)) return out;
  if (!isRecord(v)) {
    errors.accountCodes = "Send the account codes as an object";
    return out;
  }
  for (const [key, value] of Object.entries(v)) {
    if (!CODE_KEY.test(key)) {
      errors.accountCodes = "Use lower-case names like pass or adhoc_fee";
    } else if (typeof value !== "string" || !CODE_VALUE.test(value.trim())) {
      errors[`accountCodes.${key}`] = "Use up to 20 letters, digits, dots, dashes or underscores";
    } else out[key] = value.trim();
  }
  return out;
}
