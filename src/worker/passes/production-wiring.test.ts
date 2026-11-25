import { afterEach, describe, expect, it } from "vitest";

import { configureRsvpDeps, rsvpDeps } from "../rsvp/deps";
import * as rsvpDepsMod from "../rsvp/deps";
import { FakePrepaid } from "../test-support/fakes";
import { createPrepaidPort } from "./prepaid";

/** DoD 8: the story that implements PrepaidPort removes nobodyPrepaid from production wiring. */
const sources = import.meta.glob<string>(["./*.ts", "../rsvp/deps.ts", "!./*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

afterEach(() => {
  configureRsvpDeps({});
});

describe("passes & prepaid production wiring (DoD 8)", () => {
  it("has production sources to check", () => {
    expect(Object.keys(sources)).toEqual(
      expect.arrayContaining(["./prepaid.ts", "./routes.ts", "../rsvp/deps.ts"]),
    );
  });

  it("no production source keeps nobodyPrepaid or imports test-support fakes", () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(
        /nobodyPrepaid|test-support|FakePrepaid|FakeCharge|FakeReverse|FakeNotify/,
      );
    }
    expect("nobodyPrepaid" in rsvpDepsMod).toBe(false);
  });

  it("rsvpDeps().prepaid defaults to the real createPrepaidPort and resets to it", () => {
    expect(rsvpDeps().prepaid).toBe(createPrepaidPort);
    const fake = new FakePrepaid();
    configureRsvpDeps({ prepaid: () => fake });
    expect(rsvpDeps().prepaid).not.toBe(createPrepaidPort);
    configureRsvpDeps({});
    expect(rsvpDeps().prepaid).toBe(createPrepaidPort);
  });
});
