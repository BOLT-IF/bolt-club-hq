import { describe, expect, it } from "vitest";

import { API_CACHE, isNetworkFirstRoute } from "./routes";

describe("service worker route rules", () => {
  it("never caches authenticated /api/v1/me responses", () => {
    expect(isNetworkFirstRoute("/api/v1/me")).toBe(false);
    expect(isNetworkFirstRoute("/api/v1/config")).toBe(true);
  });

  it("uses v2 API cache so older cached /me entries are purged on activate", () => {
    expect(API_CACHE).toBe("bolt-club-hq-api-v2");
  });
});
