/**
 * Money is whole kronor as integers, never floats (AGENTS.md rule 5).
 */
export type Kronor = number & { readonly __brand: "Kronor" };

export function kronor(value: number): Kronor {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Money must be whole kronor, got ${String(value)}`);
  }
  return value as Kronor;
}
