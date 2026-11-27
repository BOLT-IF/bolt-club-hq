import { ApiError, apiFetch } from "../../../api/client";

export type RuleKind = "payment_due" | "event_unrsvped";

export interface PaymentDueParams {
  readonly thresholdSek: number;
}

export interface EventUnrsvpedParams {
  readonly atPublish: boolean;
  readonly hoursBeforeClose: number | null;
}

interface RuleBase {
  readonly id: string;
  readonly enabled: boolean;
  readonly minIntervalDays: number;
  readonly template: string;
}

export type ReminderRule =
  | (RuleBase & { readonly kind: "payment_due"; readonly params: PaymentDueParams })
  | (RuleBase & { readonly kind: "event_unrsvped"; readonly params: EventUnrsvpedParams });

export type RuleInput =
  | {
      readonly kind: "payment_due";
      readonly enabled: boolean;
      readonly minIntervalDays: number;
      readonly template: string;
      readonly params: PaymentDueParams;
    }
  | {
      readonly kind: "event_unrsvped";
      readonly enabled: boolean;
      readonly minIntervalDays: number;
      readonly template: string;
      readonly params: EventUnrsvpedParams;
    };

export type PlaceholdersMap = Record<RuleKind, readonly string[]>;

export interface RulesListResponse {
  readonly items: readonly ReminderRule[];
  readonly placeholders: PlaceholdersMap;
}

export interface PreviewRecipient {
  readonly memberId: string;
  readonly displayName: string;
}

export interface PreviewSample {
  readonly title: string;
  readonly body: string;
  readonly link: string;
}

export interface PreviewResponse {
  readonly count: number;
  readonly recipients: readonly PreviewRecipient[];
  readonly sample: PreviewSample | null;
}

export const KIND_LABEL: Record<RuleKind, string> = {
  payment_due: "Payment Due",
  event_unrsvped: "Un-RSVPed Event",
};

const BASE = "/admin/reminder-rules";

export function listReminderRules(): Promise<RulesListResponse> {
  return apiFetch<RulesListResponse>(BASE);
}

export function createReminderRule(body: RuleInput, idempotencyKey: string): Promise<ReminderRule> {
  return apiFetch<ReminderRule>(BASE, {
    method: "POST",
    body,
    idempotencyKey,
  });
}

export function updateReminderRule(id: string, body: RuleInput): Promise<ReminderRule> {
  return apiFetch<ReminderRule>(`${BASE}/${encodeURIComponent(id)}`, {
    method: "PUT",
    body,
  });
}

export function deleteReminderRule(id: string): Promise<void> {
  return apiFetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function previewReminderRule(id: string): Promise<PreviewResponse> {
  return apiFetch<PreviewResponse>(`${BASE}/${encodeURIComponent(id)}/preview`, {
    method: "POST",
  });
}

export function toRuleInput(rule: ReminderRule, overrides?: { enabled?: boolean }): RuleInput {
  const enabled = overrides?.enabled ?? rule.enabled;
  if (rule.kind === "payment_due") {
    return {
      kind: "payment_due",
      enabled,
      minIntervalDays: rule.minIntervalDays,
      template: rule.template,
      params: rule.params,
    };
  }
  return {
    kind: "event_unrsvped",
    enabled,
    minIntervalDays: rule.minIntervalDays,
    template: rule.template,
    params: rule.params,
  };
}

export function getErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || typeof error.body !== "object" || error.body === null) {
    return null;
  }
  const code = (error.body as { error?: unknown }).error;
  return typeof code === "string" ? code : null;
}

export function getValidationFields(error: unknown): Record<string, string> | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null;
  if (typeof error.body !== "object" || error.body === null) return null;
  const body = error.body as { error?: unknown; fields?: unknown };
  if (body.error !== "validation" || typeof body.fields !== "object" || body.fields === null) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.fields as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

export function findUnknownPlaceholders(template: string, known: readonly string[]): string[] {
  const unknown: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1] ?? "";
    if (!known.includes(name) && !unknown.includes(name)) {
      unknown.push(name);
    }
  }
  return unknown;
}
