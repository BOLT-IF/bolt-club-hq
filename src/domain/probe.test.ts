import { describe, expect, it } from "vitest";

import { kronor } from "./money";

describe("domain project", () => {
  it("keeps money as whole kronor integers", () => {
    expect(kronor(150)).toBe(150);
    expect(() => kronor(12.5)).toThrow();
  });
});
