import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { registeredFrontendRoutes } from "../routes/registry";
import { FeatureFlagsProvider } from "../lib/flags";
import { AppShell } from "./AppShell";

afterEach(() => {
  cleanup();
});

describe("route registration with the shell", () => {
  it("registers feature routes and renders them inside the shell with a back control", () => {
    const route = registeredFrontendRoutes().find((r) => r.path === "/install");
    expect(route).toBeDefined();

    const Page = route!.component;
    render(
      <FeatureFlagsProvider flags={{}}>
        <AppShell path="/install">
          <Page />
        </AppShell>
      </FeatureFlagsProvider>,
    );

    expect(screen.getByTestId("app-shell")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /install/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("hides the top-bar back button on root bottom-nav tabs and shows parent label on sub-routes", () => {
    for (const rootPath of ["/", "/events", "/money", "/inbox"]) {
      const { unmount } = render(
        <FeatureFlagsProvider flags={{ events: true, money: true, inbox: true }}>
          <AppShell path={rootPath}>
            <div>Root</div>
          </AppShell>
        </FeatureFlagsProvider>,
      );
      expect(screen.queryByRole("button", { name: /Back|Money|Admin/ })).toBeNull();
      unmount();
    }

    render(
      <FeatureFlagsProvider flags={{ events: true, money: true, inbox: true }}>
        <AppShell path="/money/claims">
          <div>Claims</div>
        </AppShell>
      </FeatureFlagsProvider>,
    );
    expect(screen.getByRole("button", { name: "Money" })).toBeTruthy();
  });
});
