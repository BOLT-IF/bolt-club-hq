import { describe, expect, it } from "vitest";

import { displayNameFor, isBootstrapEmail, newPaymentRef, primaryVerifiedEmail } from "./members";

describe("primaryVerifiedEmail", () => {
  const user = (status: string | null, primaryId = "e1") => ({
    primaryEmailAddressId: primaryId,
    emailAddresses: [
      { id: "e1", emailAddress: "Ada@Club.test", verification: status ? { status } : null },
      { id: "e2", emailAddress: "other@club.test", verification: { status: "verified" } },
    ],
  });

  it("returns the primary address, lower-cased, only when Clerk verified it", () => {
    expect(primaryVerifiedEmail(user("verified"))).toBe("ada@club.test");
  });

  it("ignores unverified, unknown-status and missing-verification primaries", () => {
    expect(primaryVerifiedEmail(user("unverified"))).toBeNull();
    expect(primaryVerifiedEmail(user("expired"))).toBeNull();
    expect(primaryVerifiedEmail(user(null))).toBeNull();
  });

  it("does not fall back to a non-primary verified address", () => {
    expect(primaryVerifiedEmail(user("unverified", "e1"))).toBeNull();
    expect(primaryVerifiedEmail({ primaryEmailAddressId: null, emailAddresses: [] })).toBeNull();
  });
});

describe("isBootstrapEmail", () => {
  it("matches case-insensitively and ignores surrounding space", () => {
    expect(isBootstrapEmail("ADA@club.test", " ada@Club.test ")).toBe(true);
  });

  it("never matches when either side is missing or empty", () => {
    expect(isBootstrapEmail(null, "ada@club.test")).toBe(false);
    expect(isBootstrapEmail("ada@club.test", undefined)).toBe(false);
    expect(isBootstrapEmail("", "")).toBe(false);
    expect(isBootstrapEmail("a@club.test", "b@club.test")).toBe(false);
  });
});

describe("displayNameFor / newPaymentRef", () => {
  it("prefers the Clerk name, then the email local part, then a placeholder", () => {
    expect(displayNameFor({ name: "Ada Lovelace", email: "ada@club.test" })).toBe("Ada Lovelace");
    expect(displayNameFor({ name: " ", email: "ada@club.test" })).toBe("ada");
    expect(displayNameFor({ name: null, email: null })).toBe("New member");
  });

  it("makes a short unambiguous payment reference", () => {
    const ref = newPaymentRef();
    expect(ref).toMatch(/^BC-[A-HJ-NP-Z2-9]{6}$/);
    expect(newPaymentRef()).not.toBe(ref);
  });
});
