import { describe, expect, it } from "vitest";

/** DoD 8: the story that implements a port removes the fake from production wiring. */
const sources = import.meta.glob<string>(["./*.ts", "!./*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("notification production wiring", () => {
  it("has production sources to check", () => {
    expect(Object.keys(sources)).toContain("./notify.ts");
  });

  it("no production source imports the test support fakes", () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/test-support|FakeNotify/);
    }
  });
});
