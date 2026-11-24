import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch, configureApiClient } from "../api/client";

const getTokenMock = vi.hoisted(() => vi.fn(() => Promise.resolve("tok_clerk")));
vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children, publishableKey }: { children: React.ReactNode; publishableKey: string }) => (
    <div data-testid="clerk" data-key={publishableKey}>
      {children}
    </div>
  ),
  getToken: getTokenMock,
}));

import { AuthProvider, useAuthEnabled } from "./AuthProvider";

function Probe() {
  return <p data-testid="enabled">{useAuthEnabled() ? "yes" : "no"}</p>;
}

afterEach(() => {
  cleanup();
  configureApiClient({});
  getTokenMock.mockClear();
});

describe("AuthProvider", () => {
  it("renders the app without Clerk, and never crashes, when no publishable key is set", () => {
    render(
      <AuthProvider publishableKey={undefined}>
        <p data-testid="app">app</p>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("app")).toBeTruthy();
    expect(screen.queryByTestId("clerk")).toBeNull();
    expect(screen.getByTestId("enabled").textContent).toBe("no");
  });

  it("treats a blank or malformed key as not configured", () => {
    render(
      <AuthProvider publishableKey="  ">
        <Probe />
      </AuthProvider>,
    );
    expect(screen.queryByTestId("clerk")).toBeNull();
  });

  it("wraps the app in ClerkProvider when a key is set and points apiFetch at the Clerk token", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    render(
      <AuthProvider publishableKey="pk_test_abc">
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("clerk").getAttribute("data-key")).toBe("pk_test_abc");
    expect(screen.getByTestId("enabled").textContent).toBe("yes");

    // The provider replaced the client config; only the fetch is swapped for the test.
    configureApiClient({
      getToken: () => getTokenMock(),
      fetch: fetchMock,
    });
    await apiFetch("/me");
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok_clerk");
  });
});
