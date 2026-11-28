import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppErrorBoundary } from "./ErrorBoundary";
import { createBrowserReporter } from "./sentry";

function Boom(): never {
  throw new Error("render failed");
}

describe("AppErrorBoundary", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the fallback with .bcq-state--error and .bcq-btn--primary when a child throws", () => {
    // React logs caught render errors to console.error; keep the test output quiet.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>,
      );
      const fallback = screen.getByTestId("error-boundary-fallback");
      expect(fallback.className).toContain("bcq-state--error");
      const btn = screen.getByRole("button", { name: /reload/i });
      expect(btn.className).toContain("bcq-btn");
      expect(btn.className).toContain("bcq-btn--primary");
    } finally {
      spy.mockRestore();
    }
  });

  it("reports the caught error to the reporter", () => {
    const reporter = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(
        <AppErrorBoundary reporter={reporter}>
          <Boom />
        </AppErrorBoundary>,
      );
      expect(reporter).toHaveBeenCalledTimes(1);
      expect(reporter.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    } finally {
      spy.mockRestore();
    }
  });

  it("renders children when nothing throws", () => {
    render(
      <AppErrorBoundary>
        <p data-testid="ok">fine</p>
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId("ok")).toBeTruthy();
    expect(screen.queryByTestId("error-boundary-fallback")).toBeNull();
  });

  it("createBrowserReporter posts to Sentry envelope when DSN is set and is silent when unset", () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    const silent = createBrowserReporter({ dsn: undefined, fetchImpl });
    silent(new Error("ignored"));
    expect(fetchImpl).not.toHaveBeenCalled();

    const active = createBrowserReporter({
      dsn: "https://abc123@o123.ingest.sentry.io/456",
      environment: "production",
      fetchImpl,
      now: () => 1_700_000_000_000,
    });
    active(new Error("boom"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://o123.ingest.sentry.io/api/456/envelope/");
  });
});
