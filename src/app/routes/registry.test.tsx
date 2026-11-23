import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { registeredFrontendRoutes } from "./registry";
import { FeatureFlagsProvider } from "../lib/flags";
import { AppShell } from "../shell/AppShell";

afterEach(() => {
  cleanup();
});

describe("probe route registration with the shell", () => {
  it("registers the probe route and renders it inside the shell with a back control", () => {
    const route = registeredFrontendRoutes().find((r) => r.path === "/probe");
    expect(route).toBeDefined();

    const Page = route!.component;
    render(
      <FeatureFlagsProvider flags={{}}>
        <AppShell path="/probe">
          <Page />
        </AppShell>
      </FeatureFlagsProvider>,
    );

    expect(screen.getByTestId("app-shell")).toBeTruthy();
    expect(screen.getByTestId("probe-route")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });
});
