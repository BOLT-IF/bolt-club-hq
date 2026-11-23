import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../index";
import { registerCronHook, resetCronHooks } from "../core/cron";
import { LAST_TICK_KEY } from "./health";
import { REQUEST_ID_HEADER } from "./logging";

// Audit fix: the S0.7 ops app (readiness, request IDs) and the cron tick were built
// but never wired into the Worker. These tests go through the real Worker entry.

const base = "https://example.test";

function runCron(cron: string): Promise<void> {
  return worker.scheduled({ cron, scheduledTime: 0, noRetry: () => undefined }, env);
}

afterEach(async () => {
  resetCronHooks();
  await env.KV.delete(LAST_TICK_KEY);
});

describe("/healthz (liveness)", () => {
  it("answers 200 ok without a cron tick, so smoke and e2e startup work on a fresh deploy", async () => {
    const res = await exports.default.fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("carries a request id", async () => {
    const res = await exports.default.fetch(`${base}/healthz`);
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(/.+/);
  });
});

describe("/healthz/ready (readiness)", () => {
  it("is degraded with 503 before any cron tick", async () => {
    const res = await exports.default.fetch(`${base}/healthz/ready`);
    expect(res.status).toBe(503);
    const body = await res.json<{ status: string; tick: { stale: boolean } }>();
    expect(body.status).toBe("degraded");
    expect(body.tick.stale).toBe(true);
  });

  it("is ok right after the scheduled handler runs", async () => {
    await runCron("0 * * * *");
    const res = await exports.default.fetch(`${base}/healthz/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", tick: { stale: false } });
  });
});

describe("scheduled()", () => {
  it("records the tick and runs only the hooks registered for that cron", async () => {
    const ran: string[] = [];
    registerCronHook("*/10 5-21 * * *", ({ cron }) => {
      ran.push(cron);
      return Promise.resolve();
    });
    registerCronHook("0 * * * *", () => {
      ran.push("wrong cron");
      return Promise.resolve();
    });

    await runCron("*/10 5-21 * * *");

    expect(ran).toEqual(["*/10 5-21 * * *"]);
    expect(await env.KV.get(LAST_TICK_KEY)).toMatch(/^\d+$/);
  });

  it("still records the tick and runs the other hooks when one throws, then rethrows", async () => {
    let otherRan = false;
    registerCronHook("0 * * * *", () => Promise.reject(new Error("hook failed")));
    registerCronHook("0 * * * *", () => {
      otherRan = true;
      return Promise.resolve();
    });

    await expect(runCron("0 * * * *")).rejects.toThrow("hook failed");
    expect(otherRan).toBe(true);
    expect(await env.KV.get(LAST_TICK_KEY)).toMatch(/^\d+$/);
  });
});
