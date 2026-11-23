import { describe, expect, it } from "vitest";

import { testIdentityFromRequest } from "./test-identity";

const withHeader = () =>
  new Request("https://example.test/api/v1/me", {
    headers: { "X-Test-Identity": "clerk_user_test_1" },
  });

describe("test-identity override", () => {
  it("is accepted when ENV is test", () => {
    expect(testIdentityFromRequest({ ENV: "test" }, withHeader())).toBe("clerk_user_test_1");
  });

  it("is rejected when ENV is dev", () => {
    expect(() => testIdentityFromRequest({ ENV: "dev" }, withHeader())).toThrow(/ENV=test/);
  });

  it("is rejected when ENV is production", () => {
    expect(() => testIdentityFromRequest({ ENV: "production" }, withHeader())).toThrow(
      /ENV=test/,
    );
  });

  it("is ignored when no header is sent", () => {
    const req = new Request("https://example.test/api/v1/me");
    expect(testIdentityFromRequest({ ENV: "dev" }, req)).toBeNull();
  });
});
