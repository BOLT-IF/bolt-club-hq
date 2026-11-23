import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { mountBackendRoutes } from "../registry";
import { requireGuard, unguardedRoutes } from "./permissions";

/**
 * Every /api/v1 route must declare a guard (AGENTS.md / PLAN §11.5).
 * Exceptions are listed here with a reason; there are none for real routes.
 */
const ALLOWLIST: readonly string[] = [
  // S0.1 placeholder, removed once a real route exists (see docs/DECISIONS.md, S0.2).
  "GET /api/v1/probe",
];

describe("route-guard lint", () => {
  it("every /api/v1 route in the backend registry declares a guard", () => {
    const app = new Hono();
    mountBackendRoutes(app);

    const offenders = unguardedRoutes(app.routes).filter(
      (route) => !ALLOWLIST.includes(`${route.method} ${route.path}`),
    );
    expect(offenders.map((route) => `${route.method} ${route.path}`)).toEqual([]);
  });

  it("detects a route that has no guard", () => {
    const app = new Hono();
    app.get("/api/v1/unguarded", (c) => c.json({}));
    expect(unguardedRoutes(app.routes).map((route) => route.path)).toEqual(["/api/v1/unguarded"]);
  });

  it("accepts a route that declares a guard", () => {
    const app = new Hono();
    app.get("/api/v1/guarded", requireGuard("member"), (c) => c.json({}));
    expect(unguardedRoutes(app.routes)).toEqual([]);
  });
});
