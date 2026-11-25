import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { AppEnv } from "../types";
import passesRoutes from "./routes";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

describe("passes context middleware scoping", () => {
  it("does not run contextMiddleware on other areas' paths", async () => {
    for (const path of ["/probe", "/config", "/events", "/members", "/me/ledger"]) {
      const res = await passesRoutes.request(path, {}, testEnv);
      expect(res.status, path).toBe(404);
    }

    const app = new Hono<AppEnv>()
      .route("/api/v1", passesRoutes)
      .get("/api/v1/other-area", (c) => c.json({ ok: true }));
    const res = await app.request("/api/v1/other-area", {}, testEnv);
    expect(res.status).toBe(200);
  });
});
