import { describe, expect, it } from "vitest";

import { CATEGORIES, isCategory, resolveLink } from "./links";

describe("deep links", () => {
  it("every category has a default link that is an in-app path", () => {
    for (const category of CATEGORIES) {
      expect(resolveLink(category, undefined)).toMatch(/^\/[a-z]/);
    }
  });

  it("sends each category to its screen", () => {
    expect(resolveLink("payment_due", undefined)).toBe("/money");
    expect(resolveLink("payment_status", undefined)).toBe("/money");
    expect(resolveLink("rsvp_status", undefined)).toBe("/events");
    expect(resolveLink("event_changes", undefined)).toBe("/events");
    expect(resolveLink("new_events", undefined)).toBe("/events");
    expect(resolveLink("polls", undefined)).toBe("/inbox");
    expect(resolveLink("announcements", undefined)).toBe("/inbox");
    expect(resolveLink("admin_tasks", undefined)).toBe("/admin");
  });

  it("keeps a given in-app link", () => {
    expect(resolveLink("rsvp_status", "/events/mon-1?x=1")).toBe("/events/mon-1?x=1");
  });

  it("replaces external or protocol-relative links with the category default", () => {
    expect(resolveLink("payment_due", "https://evil.example/pay")).toBe("/money");
    expect(resolveLink("payment_due", "//evil.example/pay")).toBe("/money");
    expect(resolveLink("payment_due", "javascript:alert(1)")).toBe("/money");
    expect(resolveLink("payment_due", "/\\evil.example")).toBe("/money");
  });

  it("knows the PLAN §10 categories", () => {
    expect(isCategory("polls")).toBe(true);
    expect(isCategory("spam")).toBe(false);
  });
});
