import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { mountBackendRoutes } from "../registry";
import type { AppEnv } from "../types";
import { requireGuard, unguardedRoutes } from "./permissions";

/**
 * Every /api/v1 route must declare a guard (AGENTS.md / PLAN §11.5).
 * Exceptions are listed here with a reason; there are none for real routes.
 */
const ALLOWLIST: readonly string[] = [
  // Public by design: the shell loads flags before sign-in (PLAN §11.6, DECISIONS "Repo audit").
  "GET /api/v1/config",
];

describe("route-guard lint", () => {
  it("every /api/v1 route in the backend registry declares a guard", () => {
    const app = new Hono<AppEnv>();
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

  it("allowInactive lets inactive members through, never pending or erased", async () => {
    const as = (status: "active" | "pending" | "inactive" | "erased") => {
      const app = new Hono();
      const actor = { id: "m1", role: "member" as const, status, seriesIds: [] };
      app.get("/x", requireGuard("member", { allowInactive: true, actorOf: () => actor }), (c) =>
        c.json({}),
      );
      app.get("/y", requireGuard("member", { actorOf: () => actor }), (c) => c.json({}));
      return app;
    };
    expect((await as("inactive").request("/x")).status).toBe(200);
    expect((await as("inactive").request("/y")).status).toBe(403);
    expect((await as("pending").request("/x")).status).toBe(403);
    expect((await as("erased").request("/x")).status).toBe(403);
    expect((await as("active").request("/x")).status).toBe(200);
  });

  it("accepts a route that declares a guard", () => {
    const app = new Hono();
    app.get("/api/v1/guarded", requireGuard("member"), (c) => c.json({}));
    expect(unguardedRoutes(app.routes)).toEqual([]);
  });
});
