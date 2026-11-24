import { describe, expect, it } from "vitest";

import { matchPath, resolveRoute, type AppRoute } from "./registry";

const Noop = () => null;

describe("route matching (W2 contract)", () => {
  it("extracts :params and rejects other shapes", () => {
    expect(matchPath("/events/:slug", "/events/ab%20c")).toEqual({ slug: "ab c" });
    expect(matchPath("/events/:slug", "/events")).toBeNull();
    expect(matchPath("/events/:slug", "/money/x")).toBeNull();
  });

  it("exact paths win over patterns", () => {
    const routes: AppRoute[] = [
      { path: "/events/:slug", component: Noop },
      { path: "/events/new", component: Noop },
    ];
    expect(resolveRoute("/events/new", routes)?.route.path).toBe("/events/new");
    expect(resolveRoute("/events/x1", routes)?.params).toEqual({ slug: "x1" });
    expect(resolveRoute("/nope", routes)).toBeNull();
  });
});
