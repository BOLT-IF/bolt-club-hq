import { describe, expect, it } from "vitest";

import { pingHealthcheck } from "./ping";

function stubFetch(): { calls: string[]; fetch: typeof fetch } {
  const calls: string[] = [];
  return {
    calls,
    fetch: ((input: string) => {
      calls.push(input);
      return Promise.resolve(new Response("OK"));
    }) as typeof fetch,
  };
}

describe("healthchecks.io ping", () => {
  it("pings the URL on success and appends /fail on failure", async () => {
    const f = stubFetch();
    const env = { HEALTHCHECK_PING_URL: "https://hc-ping.com/abc" };
    await pingHealthcheck(env, "success", f.fetch);
    await pingHealthcheck(env, "fail", f.fetch);
    expect(f.calls).toEqual(["https://hc-ping.com/abc", "https://hc-ping.com/abc/fail"]);
  });

  it("does nothing when no URL is configured", async () => {
    const f = stubFetch();
    await pingHealthcheck({}, "success", f.fetch);
    expect(f.calls).toEqual([]);
  });

  it("never throws when the ping itself fails", async () => {
    const failing = (() => Promise.reject(new Error("network"))) as typeof fetch;
    await expect(
      pingHealthcheck({ HEALTHCHECK_PING_URL: "https://hc-ping.com/abc" }, "success", failing),
    ).resolves.toBeUndefined();
  });
});
