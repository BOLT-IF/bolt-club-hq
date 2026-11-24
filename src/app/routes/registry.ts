import type { ComponentType } from "react";

import { useCurrentPath } from "../lib/navigate";

export interface AppRoute {
  /** Exact path, or a pattern with `:name` segments, e.g. "/events/:slug". */
  readonly path: string;
  readonly component: ComponentType;
}

/**
 * Frontend route registry. Any `src/app/routes/**\/routes.tsx` (nested folders such as
 * `admin/members/` included) default-exports one `AppRoute` or an array of them.
 * New areas are picked up automatically via import.meta.glob.
 */
const routeModules = import.meta.glob<{ default: AppRoute | readonly AppRoute[] }>(
  "./**/routes.tsx",
  { eager: true },
);

export function registeredFrontendRoutes(): AppRoute[] {
  return Object.values(routeModules).flatMap((mod) =>
    Array.isArray(mod.default)
      ? [...(mod.default as readonly AppRoute[])]
      : [mod.default as AppRoute],
  );
}

/** Params from matching `path` against `pattern`, or null. "/events/:slug" + "/events/ab" → { slug: "ab" }. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const got = path.split("/").filter(Boolean);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (const [i, segment] of want.entries()) {
    const actual = got[i] ?? "";
    if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(actual);
    else if (segment !== actual) return null;
  }
  return params;
}

/** The route for `path`: exact paths win over patterns. */
export function resolveRoute(
  path: string,
  routes: readonly AppRoute[] = registeredFrontendRoutes(),
): { route: AppRoute; params: Record<string, string> } | null {
  const exact = routes.find((r) => r.path === path);
  if (exact) return { route: exact, params: {} };
  for (const route of routes) {
    const params = matchPath(route.path, path);
    if (params) return { route, params };
  }
  return null;
}

/** Params of the current route inside a page component, e.g. `useRouteParams().slug`. */
export function useRouteParams(): Record<string, string> {
  return resolveRoute(useCurrentPath())?.params ?? {};
}
