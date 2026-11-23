import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { registeredBackendRoutes } from "../registry";

describe("backend route auto-registration", () => {
  it("registers the probe route from src/worker/probe/routes.ts without manual wiring", async () => {
    const paths = registeredBackendRoutes().map((route) => route.path);
    expect(paths).toContain("/api/v1/probe");

    const res = await SELF.fetch("https://example.test/api/v1/probe");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ probe: "ok" });
  });
});

describe("same-origin serving", () => {
  it("serves /healthz from the Worker", async () => {
    const res = await SELF.fetch("https://example.test/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });
});
