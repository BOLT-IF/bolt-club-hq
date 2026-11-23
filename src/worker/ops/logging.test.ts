import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { createLogger, type LogLine, requestIdMiddleware } from "./logging";
import { createLaunchCounters, type CounterSink } from "./metrics";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function captureApp() {
  const lines: LogLine[] = [];
  const sink = (line: LogLine) => lines.push(line);
  const app = new Hono<{
    Variables: { requestId: string; logger: ReturnType<typeof createLogger> };
  }>();
  app.use(requestIdMiddleware({ sink, now: () => 1_700_000_000_000 }));
  app.get("/work", (c) => {
    c.var.logger.info("work.started", { step: 1 });
    c.var.logger.warn("work.slow");
    return c.json({ ok: true });
  });
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  app.onError((err, c) => {
    c.var.logger.error("request.failed", { message: err.message });
    return c.json({ error: "internal" }, 500);
  });
  return { app, lines };
}

describe("request ID", () => {
  it("generates a UUID and echoes it in the x-request-id response header", async () => {
    const { app } = captureApp();
    const res = await app.request("/work");
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(UUID_RE);
  });

  it("reuses an incoming x-request-id header", async () => {
    const { app } = captureApp();
    const res = await app.request("/work", { headers: { "x-request-id": "abc-123" } });
    expect(res.headers.get("x-request-id")).toBe("abc-123");
  });
});

describe("structured logs", () => {
  it("every log line emitted during a request carries the same request ID", async () => {
    const { app, lines } = captureApp();
    const res = await app.request("/work");
    const id = res.headers.get("x-request-id");

    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line.requestId).toBe(id);
    }
  });

  it("includes the request ID on error log lines too", async () => {
    const { app, lines } = captureApp();
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const errorLine = lines.find((l) => l.event === "request.failed");
    expect(errorLine).toBeDefined();
    expect(errorLine?.requestId).toBe(res.headers.get("x-request-id"));
    expect(errorLine?.level).toBe("error");
  });

  it("emits JSON-serialisable lines with level, event, timestamp and request ID", async () => {
    const { app, lines } = captureApp();
    await app.request("/work");
    const parsed = JSON.parse(JSON.stringify(lines[0])) as LogLine;
    expect(parsed).toMatchObject({
      level: "info",
      event: "work.started",
      step: 1,
      ts: 1_700_000_000_000,
    });
    expect(typeof parsed.requestId).toBe("string");
  });
});

describe("launch-metric counters", () => {
  it("counts link-RSVP, push opt-in and claim-to-confirmation timing", () => {
    const events: Array<{ name: string; labels?: Record<string, string>; value?: number }> = [];
    const sink: CounterSink = {
      increment: (name, labels) => {
        events.push(labels === undefined ? { name } : { name, labels });
      },
      observe: (name, value, labels) => {
        events.push(labels === undefined ? { name, value } : { name, value, labels });
      },
    };
    const counters = createLaunchCounters(sink);

    counters.linkRsvp("rsvped");
    counters.linkRsvp("viewed");
    counters.pushOptIn(true);
    counters.claimToConfirmation(4_500);

    expect(events).toEqual([
      { name: "launch.link_rsvp", labels: { outcome: "rsvped" } },
      { name: "launch.link_rsvp", labels: { outcome: "viewed" } },
      { name: "launch.push_opt_in", labels: { opted_in: "true" } },
      { name: "launch.claim_to_confirmation_ms", value: 4_500, labels: {} },
    ]);
  });
});
