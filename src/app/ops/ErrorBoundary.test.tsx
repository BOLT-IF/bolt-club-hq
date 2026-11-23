import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppErrorBoundary } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("render failed");
}

describe("AppErrorBoundary", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the fallback when a child throws", () => {
    // React logs caught render errors to console.error; keep the test output quiet.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>,
      );
      expect(screen.getByTestId("error-boundary-fallback")).toBeTruthy();
      expect(screen.getByRole("button", { name: /reload/i })).toBeTruthy();
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
});
