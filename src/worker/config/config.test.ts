import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { flagsFromEnv } from "./flags";

// Audit fix: the shell loads /api/v1/config at startup (S0.4), but no route served it,
// so every real load 404'd and all flagged nav entries stayed hidden.

describe("flagsFromEnv (PLAN §11.5: per-area flags from env vars)", () => {
  it("turns FLAG_<AREA> vars into lower-case area flags", () => {
    expect(flagsFromEnv({ FLAG_EVENTS: "on", FLAG_MONEY: "true", FLAG_INBOX: "1" })).toEqual({
      events: true,
      money: true,
      inbox: true,
    });
  });

  it("fails closed: any other value is off", () => {
    expect(flagsFromEnv({ FLAG_EVENTS: "off", FLAG_MONEY: "", FLAG_INBOX: "yes please" })).toEqual(
      { events: false, money: false, inbox: false },
    );
  });

  it("ignores vars that are not flags, so secrets never reach the client", () => {
    expect(flagsFromEnv({ ENV: "test", SENTRY_DSN: "https://k@x/1", FLAG_EVENTS: "on" })).toEqual({
      events: true,
    });
  });

  it("ignores non-string bindings", () => {
    expect(flagsFromEnv({ FLAG_EVENTS: { not: "a string" }, KV: {} })).toEqual({});
  });
});

describe("GET /api/v1/config", () => {
  it("is served by the Worker without auth, as JSON with a flags object", async () => {
    const res = await exports.default.fetch("https://example.test/api/v1/config");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json<{ flags: Record<string, boolean> }>();
    expect(typeof body.flags).toBe("object");
  });
});
