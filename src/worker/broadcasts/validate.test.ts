import { describe, expect, it } from "vitest";

import { parseBroadcast } from "./validate";

const ok = (audience: unknown) => parseBroadcast({ title: " Hello ", body: "World", audience });

describe("parseBroadcast", () => {
  it("accepts every audience kind and trims text", () => {
    expect(ok({ kind: "all" })).toEqual({
      ok: true,
      value: { title: "Hello", body: "World", audience: { kind: "all" } },
    });
    expect(ok({ kind: "pass_holders" })).toMatchObject({ ok: true });
    expect(ok({ kind: "pass_holders", seriesId: "s1" })).toMatchObject({
      ok: true,
      value: { audience: { kind: "pass_holders", seriesId: "s1" } },
    });
    expect(ok({ kind: "captains" })).toMatchObject({ ok: true });
    expect(ok({ kind: "event_rsvps", eventId: "e1" })).toMatchObject({
      ok: true,
      value: { audience: { kind: "event_rsvps", eventId: "e1" } },
    });
  });

  it("rejects bad input", () => {
    expect(parseBroadcast(null)).toEqual({ ok: false, error: "invalid_body" });
    expect(parseBroadcast({ title: "", body: "x", audience: { kind: "all" } })).toEqual({
      ok: false,
      error: "title_required",
    });
    expect(parseBroadcast({ title: "x", body: "  ", audience: { kind: "all" } })).toEqual({
      ok: false,
      error: "body_required",
    });
    expect(
      parseBroadcast({ title: "x".repeat(101), body: "x", audience: { kind: "all" } }),
    ).toEqual({
      ok: false,
      error: "title_too_long",
    });
    expect(
      parseBroadcast({ title: "x", body: "x".repeat(1001), audience: { kind: "all" } }),
    ).toEqual({
      ok: false,
      error: "body_too_long",
    });
    expect(ok({ kind: "everyone" })).toEqual({ ok: false, error: "invalid_audience" });
    expect(ok(undefined)).toEqual({ ok: false, error: "invalid_audience" });
    expect(ok({ kind: "event_rsvps" })).toEqual({ ok: false, error: "invalid_audience" });
  });
});
