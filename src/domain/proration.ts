/**
 * Pure pass proration and terms notice (PLAN §6.5). No I/O, no clock.
 * All money values are whole kronor (integers).
 */

export interface PassOfferInput {
  readonly passPrice: number;
  readonly remainingEvents: number;
  readonly totalEvents: number;
}

export type PassOfferCalculation =
  | {
      readonly offered: true;
      readonly priceSek: number;
      readonly remainingEvents: number;
      readonly totalEvents: number;
    }
  | {
      readonly offered: false;
      readonly reason: "no_events_remaining";
    };

function assertNonNegInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`proration: ${name} must be a non-negative integer, got ${String(value)}`);
  }
}

/**
 * Computes `round_half_up(passPrice * remaining / total)` using exact integer arithmetic
 * so floating-point precision never shifts a `.5` boundary.
 */
export function roundHalfUpRatio(passPrice: number, remaining: number, total: number): number {
  assertNonNegInt(passPrice, "passPrice");
  assertNonNegInt(remaining, "remaining");
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new RangeError(`proration: total must be a positive integer, got ${String(total)}`);
  }
  const numerator = 2n * BigInt(passPrice) * BigInt(remaining) + BigInt(total);
  const denominator = 2n * BigInt(total);
  return Number(numerator / denominator);
}

/**
 * Computes the prorated pass offer for a series. Never offers a pass when 0 events remain
 * or total events is 0 (PLAN §6.5).
 */
export function computePassOffer(input: PassOfferInput): PassOfferCalculation {
  assertNonNegInt(input.passPrice, "passPrice");
  assertNonNegInt(input.remainingEvents, "remainingEvents");
  assertNonNegInt(input.totalEvents, "totalEvents");
  if (input.remainingEvents > input.totalEvents) {
    throw new RangeError(
      `proration: remainingEvents (${String(input.remainingEvents)}) cannot exceed totalEvents (${String(input.totalEvents)})`,
    );
  }
  if (input.remainingEvents === 0 || input.totalEvents === 0) {
    return { offered: false, reason: "no_events_remaining" };
  }
  return {
    offered: true,
    priceSek: roundHalfUpRatio(input.passPrice, input.remainingEvents, input.totalEvents),
    remainingEvents: input.remainingEvents,
    totalEvents: input.totalEvents,
  };
}

/** Standard pre-purchase terms notice required by PLAN §6.5. */
export function passTermsNotice(eventsCovered: number): string {
  assertNonNegInt(eventsCovered, "eventsCovered");
  return `Covers up to ${String(eventsCovered)} sessions; no refunds; cancelled nights not compensated.`;
}
