import { describe, expect, it } from "vitest";

/** DoD 8: the story that implements ChargePort and ReversePort removes the fakes from production. */
const sources = import.meta.glob<string>(["./*.ts", "!./*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("ledger production wiring", () => {
  it("has production sources to check", () => {
    expect(Object.keys(sources)).toEqual(
      expect.arrayContaining(["./service.ts", "./ports.ts", "./routes.ts"]),
    );
  });

  it("no production source imports the test support fakes", () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/test-support|FakeCharge|FakeReverse/);
    }
  });

  it("the ports module exports the production adapters", async () => {
    const mod = await import("./ports");
    expect(typeof mod.createChargePort).toBe("function");
    expect(typeof mod.createReversePort).toBe("function");
  });
});
