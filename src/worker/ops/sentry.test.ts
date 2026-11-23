import { describe, expect, it, vi } from "vitest";

import {
  buildEnvelope,
  createSentryReporter,
  parseDsn,
  scrubHeaders,
  scrubMessage,
} from "./sentry";

const DSN = "https://abc123@o1.ingest.sentry.io/42";

describe("Worker Sentry reporter", () => {
  it("is off when no DSN is configured", () => {
    expect(createSentryReporter({}, { environment: "test" })).toBeNull();
  });

  it("posts one envelope to the project endpoint with the scrubbed message", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const report = createSentryReporter(
      { SENTRY_DSN: DSN },
      { environment: "test", fetchImpl: fetchImpl },
    );
    expect(report).not.toBeNull();
    await report!(new Error("failed for ana@example.com card 1234567890"));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://o1.ingest.sentry.io/api/42/envelope/");
    const body = init.body as string;
    expect(body).not.toContain("ana@example.com");
    expect(body).not.toContain("1234567890");
    expect(body).toContain("[email]");
  });

  it("never throws when the network fails", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("offline")));
    const report = createSentryReporter(
      { SENTRY_DSN: DSN },
      { environment: "test", fetchImpl: fetchImpl },
    );
    await expect(report!(new Error("x"))).resolves.toBeUndefined();
  });
});

describe("Sentry helpers", () => {
  it("parses a DSN and rejects a malformed one", () => {
    expect(parseDsn(DSN)).toEqual({
      publicKey: "abc123",
      host: "o1.ingest.sentry.io",
      projectId: "42",
    });
    expect(parseDsn("not a dsn")).toBeNull();
  });

  it("drops authorization and cookie headers", () => {
    expect(scrubHeaders({ authorization: "Bearer x", cookie: "a=b", accept: "*/*" })).toEqual({
      accept: "*/*",
    });
  });

  it("builds a three-line envelope with the event type", () => {
    const dsn = parseDsn(DSN)!;
    const [header, item, event] = buildEnvelope(new TypeError("bad"), dsn, {
      eventId: "e1",
      timestamp: 1_700_000_000_000,
      environment: "test",
    }).split("\n");
    expect(JSON.parse(header!)).toMatchObject({ event_id: "e1" });
    expect(JSON.parse(item!)).toMatchObject({ type: "event" });
    expect(JSON.parse(event!)).toMatchObject({ exception: { values: [{ type: "TypeError" }] } });
  });

  it("scrubs emails and long digit runs", () => {
    expect(scrubMessage("x y@z.io 12345678")).toBe("x [email] [number]");
  });
});
