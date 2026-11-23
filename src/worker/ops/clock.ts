/**
 * Injected time source (AGENTS.md rule 6). Ops code takes a `Clock` so tests can
 * move time. S0.2 owns the canonical `Clock` in `src/worker/core/`; this structural
 * type stays compatible with it.
 */
export interface Clock {
  now(): number;
}

/** Epoch milliseconds from the high-resolution clock. Avoids `Date.now()`, which lint forbids in the Worker. */
export const systemClock: Clock = {
  now: () => Math.round(performance.timeOrigin + performance.now()),
};
