import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { registeredFrontendRoutes } from "../registry";

describe("frontend route auto-registration", () => {
  it("registers the probe route from src/app/routes/probe/routes.tsx without manual wiring", () => {
    const paths = registeredFrontendRoutes().map((route) => route.path);
    expect(paths).toContain("/probe");
  });

  it("renders the probe route component", () => {
    const route = registeredFrontendRoutes().find((r) => r.path === "/probe");
    expect(route).toBeDefined();
    const Component = route!.component;
    render(<Component />);
    expect(screen.getByTestId("probe-route")).toBeTruthy();
  });
});
