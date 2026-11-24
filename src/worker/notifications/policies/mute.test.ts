import { describe, expect, it } from "vitest";

import { defaultPolicies } from "../policy";

describe("mute policy registration", () => {
  it("is auto-registered in the mute slot (order 10), ahead of the other policies", () => {
    const mute = defaultPolicies.find((p) => p.id === "mute");
    expect(mute?.order).toBe(10);
    expect(defaultPolicies.indexOf(mute!)).toBe(0);
  });
});
