import { describe, expect, it } from "vitest";

import routes from "./routes";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

describe("terms sub-app scoping (contract correction)", () => {
  it("does not run its context middleware on other areas' paths", async () => {
    // The sub-app is mounted at /api/v1. A "*" middleware would open the database for
    // /probe or /config and fail here (no Hyperdrive binding); scoped paths answer 404.
    for (const path of ["/probe", "/config", "/events", "/members"]) {
      const res = await routes.request(path, {}, testEnv);
      expect(res.status, path).toBe(404);
    }
  });
});
