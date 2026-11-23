/**
 * Injected time source (AGENTS.md rule 6, PLAN §11.5). Domain and worker code
 * must never call `Date.now()` or `new Date()` directly; they take a Clock.
 * Store and compare instants as UTC.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test clock: starts at a fixed instant and only moves when told to. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date | string) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(at: Date | string): void {
    this.current = new Date(at);
  }
}
