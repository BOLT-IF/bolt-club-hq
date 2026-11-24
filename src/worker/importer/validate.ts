import { MAX_AMOUNT_SEK } from "../../domain/ledger";

export const MAX_IMPORT_ROWS = 500;
const DISPLAY_NAME_MAX = 80;
const ROSTER_NAME_MAX = 40;
const EMAIL_MAX = 254;
const NOTE_MAX = 500;
const DEFAULT_OPENING_NOTE = "Opening balance import";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAYMENT_REF_RE = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

const ALLOWED_ROW_KEYS = new Set([
  "displayName",
  "email",
  "rosterName",
  "role",
  "status",
  "paymentRef",
  "openingBalanceSek",
  "note",
]);

export interface ValidatedImportRow {
  row: number;
  displayName: string;
  email: string;
  rosterName: string | null;
  role: "member" | "admin";
  status: "active" | "inactive";
  paymentRef: string | null;
  openingBalanceSek: number;
  note: string;
}

export interface ImportRowError {
  row: number;
  field: string;
  error: string;
}

export type ValidateImportResult =
  | { ok: true; rows: ValidatedImportRow[] }
  | { ok: false; error: "invalid_body" | "invalid_import_rows"; errors: ImportRowError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the entire `POST /admin/members/import` payload upfront so malformed rows
 * are reported together and never produce a partial import.
 */
export function validateImportBody(input: unknown): ValidateImportResult {
  if (!isPlainObject(input)) {
    return { ok: false, error: "invalid_body", errors: [] };
  }
  const topKeys = Object.keys(input);
  if (topKeys.some((k) => k !== "rows") || !Array.isArray(input.rows)) {
    return { ok: false, error: "invalid_body", errors: [] };
  }
  if (input.rows.length === 0 || input.rows.length > MAX_IMPORT_ROWS) {
    return { ok: false, error: "invalid_body", errors: [] };
  }

  const errors: ImportRowError[] = [];
  const validated: ValidatedImportRow[] = [];
  const seenEmails = new Set<string>();
  const seenRefs = new Set<string>();

  for (let i = 0; i < input.rows.length; i++) {
    const raw: unknown = input.rows[i];
    if (!isPlainObject(raw)) {
      errors.push({ row: i, field: "row", error: "invalid_row" });
      continue;
    }

    for (const key of Object.keys(raw)) {
      if (!ALLOWED_ROW_KEYS.has(key)) {
        errors.push({ row: i, field: key, error: "unknown_field" });
      }
    }

    const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
    if (displayName === "" || displayName.length > DISPLAY_NAME_MAX) {
      errors.push({ row: i, field: "displayName", error: "invalid_display_name" });
    }

    const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
    if (email === "" || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
      errors.push({ row: i, field: "email", error: "invalid_email" });
    } else if (seenEmails.has(email)) {
      errors.push({ row: i, field: "email", error: "duplicate_email" });
    } else {
      seenEmails.add(email);
    }

    let rosterName: string | null = null;
    if (raw.rosterName !== undefined && raw.rosterName !== null) {
      if (typeof raw.rosterName !== "string") {
        errors.push({ row: i, field: "rosterName", error: "invalid_roster_name" });
      } else {
        const trimmed = raw.rosterName.trim();
        if (trimmed.length > ROSTER_NAME_MAX) {
          errors.push({ row: i, field: "rosterName", error: "invalid_roster_name" });
        } else {
          rosterName = trimmed === "" ? null : trimmed;
        }
      }
    }

    let role: "member" | "admin" = "member";
    if (raw.role !== undefined) {
      if (raw.role === "member" || raw.role === "admin") {
        role = raw.role;
      } else {
        errors.push({ row: i, field: "role", error: "invalid_role" });
      }
    }

    let status: "active" | "inactive" = "active";
    if (raw.status !== undefined) {
      if (raw.status === "active" || raw.status === "inactive") {
        status = raw.status;
      } else {
        errors.push({ row: i, field: "status", error: "invalid_status" });
      }
    }

    let paymentRef: string | null = null;
    if (raw.paymentRef !== undefined && raw.paymentRef !== null) {
      if (typeof raw.paymentRef !== "string") {
        errors.push({ row: i, field: "paymentRef", error: "invalid_payment_ref" });
      } else {
        const normalizedRef = raw.paymentRef.trim().toUpperCase();
        if (normalizedRef !== "") {
          if (!PAYMENT_REF_RE.test(normalizedRef)) {
            errors.push({ row: i, field: "paymentRef", error: "invalid_payment_ref" });
          } else if (seenRefs.has(normalizedRef)) {
            errors.push({ row: i, field: "paymentRef", error: "duplicate_payment_ref" });
          } else {
            seenRefs.add(normalizedRef);
            paymentRef = normalizedRef;
          }
        }
      }
    }

    const openingBalanceSek = raw.openingBalanceSek;
    if (
      typeof openingBalanceSek !== "number" ||
      !Number.isSafeInteger(openingBalanceSek) ||
      Math.abs(openingBalanceSek) > MAX_AMOUNT_SEK
    ) {
      errors.push({ row: i, field: "openingBalanceSek", error: "invalid_amount" });
    }

    let note = DEFAULT_OPENING_NOTE;
    if (raw.note !== undefined && raw.note !== null) {
      if (typeof raw.note !== "string" || raw.note.length > NOTE_MAX) {
        errors.push({ row: i, field: "note", error: "invalid_note" });
      } else {
        const trimmed = raw.note.trim();
        note = trimmed === "" ? DEFAULT_OPENING_NOTE : trimmed;
      }
    }

    if (typeof openingBalanceSek === "number" && Number.isSafeInteger(openingBalanceSek)) {
      validated.push({
        row: i,
        displayName,
        email,
        rosterName,
        role,
        status,
        paymentRef,
        openingBalanceSek,
        note,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: "invalid_import_rows", errors };
  }
  return { ok: true, rows: validated };
}
