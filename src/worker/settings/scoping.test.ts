import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import type { AppEnv } from "../types";
import settingsRoutes from "./routes";

const env = { ENV: "test" } as unknown as Cloudflare.Env;

describe("settings context middleware scope", () => {
  it("does not leak onto routes mounted after it (they never open the database)", async () => {
    const app = new Hono<AppEnv>()
      .route("/api/v1", settingsRoutes)
      .get("/api/v1/other-area", (c) => c.json({ ok: true }));

    const res = await app.request("/api/v1/other-area", {}, env);
    expect(res.status).toBe(200);
  });
});
