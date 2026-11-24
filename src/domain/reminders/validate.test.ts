import { describe, expect, it } from "vitest";

import { renderTemplate, unknownPlaceholders, validateRuleInput } from "./index";

describe("rule validation", () => {
  it("accepts a payment rule and defaults the interval to 90 days", () => {
    const r = validateRuleInput({
      kind: "payment_due",
      template: "Hi {name}, you owe {balance}",
      params: { thresholdSek: 200 },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        kind: "payment_due",
        enabled: true,
        minIntervalDays: 90,
        template: "Hi {name}, you owe {balance}",
        params: { thresholdSek: 200 },
      },
    });
  });

  it("rejects an unknown placeholder", () => {
    const r = validateRuleInput({
      kind: "payment_due",
      template: "Hi {name}, {event} {oops}",
      params: { thresholdSek: 200 },
    });
    expect(r).toEqual({ ok: false, errors: { template: "unknown placeholder: {event}, {oops}" } });
  });

  it("rejects non-integer money and an event rule with no stage", () => {
    const pay = validateRuleInput({
      kind: "payment_due",
      template: "x",
      params: { thresholdSek: 99.5 },
    });
    expect(pay.ok ? null : pay.errors).toHaveProperty("params.thresholdSek");
    const ev = validateRuleInput({ kind: "event_unrsvped", template: "x", params: {} });
    expect(ev.ok ? null : ev.errors).toHaveProperty("params");
  });

  it("rejects an unknown kind", () => {
    expect(validateRuleInput({ kind: "polls", template: "x", params: {} }).ok).toBe(false);
  });
});

describe("templates", () => {
  it("lists unknown placeholders and renders known ones", () => {
    expect(unknownPlaceholders("event_unrsvped", "{event} {balance}")).toEqual(["balance"]);
    expect(renderTemplate("{name} owes {balance}", { name: "Ada", balance: "5 kr" })).toBe(
      "Ada owes 5 kr",
    );
  });
});
