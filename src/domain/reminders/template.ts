import type { RuleKind } from "./types";

/** Placeholders each rule kind understands, written `{name}` in a template. */
export const PLACEHOLDERS: Record<RuleKind, readonly string[]> = {
  payment_due: ["name", "balance", "paymentRef"],
  event_unrsvped: ["name", "event", "when", "closes"],
};

export const TEMPLATE_MAX_LENGTH = 500;

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** Placeholders used in `template` that `kind` does not know, in order of appearance. */
export function unknownPlaceholders(kind: RuleKind, template: string): string[] {
  const known = PLACEHOLDERS[kind];
  const unknown: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? "";
    if (!known.includes(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

/** Fills `{placeholder}`s. Unknown ones are left as written (validation rejects them on save). */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => vars[name] ?? whole);
}
