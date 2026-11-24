import { describe, expect, it } from "vitest";

import { randomSlug, SLUG_ALPHABET, SLUG_LENGTH, uniqueSlug } from "./slugs";

describe("share slugs (PLAN §5.1: random, 8+ characters)", () => {
  it("is at least 8 characters and only uses the URL-safe alphabet", () => {
    expect(SLUG_LENGTH).toBeGreaterThanOrEqual(8);
    const pattern = new RegExp(`^[${SLUG_ALPHABET}]{${String(SLUG_LENGTH)}}$`);
    for (let i = 0; i < 200; i++) expect(randomSlug()).toMatch(pattern);
  });

  it("does not repeat across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(randomSlug());
    expect(seen.size).toBe(5000);
  });

  it("uniqueSlug draws again when the slug is taken", async () => {
    const asked: string[] = [];
    const slug = await uniqueSlug((candidate) => {
      asked.push(candidate);
      return Promise.resolve(asked.length === 1);
    });
    expect(asked).toHaveLength(2);
    expect(slug).toBe(asked[1]);
  });

  it("uniqueSlug gives up instead of looping forever", async () => {
    await expect(uniqueSlug(() => Promise.resolve(true))).rejects.toThrow(/slug/i);
  });
});
