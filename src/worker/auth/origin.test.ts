import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { mountBackendRoutes } from "../registry";
import type { AppEnv } from "../types";
import { originGuard } from "./origin";

const env = { ENV: "test" } as unknown as Cloudflare.Env;

function app() {
  return new Hono<AppEnv>()
    .use("*", originGuard())
    .get("/thing", (c) => c.json({ ok: true }))
    .post("/thing", (c) => c.json({ ok: true }));
}

const post = (a: ReturnType<typeof app>, origin?: string) =>
  a.request(
    "https://club.test/thing",
    { method: "POST", headers: origin === undefined ? {} : { Origin: origin } },
    env,
  );

describe("origin guard (state-changing requests)", () => {
  it("rejects a POST from another origin with 403", async () => {
    const res = await post(app(), "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "bad_origin" });
  });

  it("rejects Origin: null and an unparsable Origin", async () => {
    expect((await post(app(), "null")).status).toBe(403);
    expect((await post(app(), "::::")).status).toBe(403);
  });

  it("allows the same origin, and requests with no Origin header (bearer-only clients)", async () => {
    expect((await post(app(), "https://club.test")).status).toBe(200);
    expect((await post(app())).status).toBe(200);
  });

  it("applies to PUT, PATCH and DELETE, not to GET", async () => {
    const a = new Hono<AppEnv>().use("*", originGuard()).all("/thing", (c) => c.json({ ok: true }));
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await a.request(
        "https://club.test/thing",
        { method, headers: { Origin: "https://evil.example" } },
        env,
      );
      expect(res.status).toBe(403);
    }
    const get = await a.request(
      "https://club.test/thing",
      { headers: { Origin: "https://evil.example" } },
      env,
    );
    expect(get.status).toBe(200);
  });

  it("covers every /api/v1 route through the backend registry, even ones that do not exist yet", async () => {
    const root = new Hono<AppEnv>();
    mountBackendRoutes(root);
    const bad = await root.request(
      "https://club.test/api/v1/anything",
      { method: "POST", headers: { Origin: "https://evil.example" } },
      env,
    );
    expect(bad.status).toBe(403);
    const good = await root.request(
      "https://club.test/api/v1/anything",
      { method: "POST", headers: { Origin: "https://club.test" } },
      env,
    );
    expect(good.status).toBe(404);
  });
});
