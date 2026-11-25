import { ApiError, apiFetch } from "../../../api/client";

export interface PassOffer {
  readonly seriesId: string;
  readonly seriesName: string;
  readonly termId: string;
  readonly termName: string;
  readonly format: string;
  readonly weekday: number;
  readonly startTime: string;
  readonly durationMin: number;
  readonly location: string | null;
  readonly passPrice: number;
  readonly priceSek: number;
  readonly remainingEvents: number;
  readonly totalEvents: number;
  readonly passCap: number;
  readonly passesSold: number;
  readonly seatsRemaining: number;
  readonly alreadyOwned: boolean;
  readonly termsNotice: string;
}

export interface MemberPass {
  readonly id: string;
  readonly seriesId: string;
  readonly seriesName: string;
  readonly termName: string;
  readonly priceCharged: number;
  readonly eventsCovered: number;
  readonly status: "active" | "revoked";
  readonly purchasedAt: string;
  readonly revokedAt: string | null;
}

export interface PassesOverview {
  readonly offers: readonly PassOffer[];
  readonly passes: readonly MemberPass[];
}

export interface PurchasePassResult {
  readonly pass: MemberPass;
  readonly upgradedRsvps: number;
}

export function fetchPassOffers(signal?: AbortSignal): Promise<PassesOverview> {
  return apiFetch<PassesOverview>("/passes/offers", signal ? { signal } : {});
}

export function purchasePass(
  seriesId: string,
  idempotencyKey: string,
): Promise<PurchasePassResult> {
  return apiFetch<PurchasePassResult>("/passes", {
    method: "POST",
    body: { seriesId },
    idempotencyKey,
  });
}

const MESSAGES: Record<string, string> = {
  pass_cap_reached: "All pass seats for this series are taken.",
  already_has_pass: "You already hold an active pass for this series.",
  no_events_remaining: "No sessions remain in this series.",
  term_not_open: "Pass sales for this term are closed.",
  idempotency_key_in_progress: "Still finishing your first request. Try again in a moment.",
  idempotency_conflict: "This conflicted with an earlier attempt. Reload the page.",
};

export function describePassError(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.body as { error?: unknown } | null)?.error;
    if (typeof code === "string" && MESSAGES[code]) return MESSAGES[code];
    if (error.status === 403) return "Only active members can buy passes.";
  }
  return "Couldn't complete the purchase. Check your connection and try again.";
}

export function isFinalPassRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500) return false;
  return (error.body as { error?: unknown } | null)?.error !== "idempotency_key_in_progress";
}
