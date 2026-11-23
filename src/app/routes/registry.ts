import type { ComponentType } from "react";

export interface AppRoute {
  readonly path: string;
  readonly component: ComponentType;
}

/**
 * Frontend route registry. Each `src/app/routes/<area>/routes.tsx` default-exports
 * an `AppRoute`. New areas are picked up automatically via import.meta.glob.
 */
const routeModules = import.meta.glob<{ default: AppRoute }>("./*/routes.tsx", {
  eager: true,
});

export function registeredFrontendRoutes(): AppRoute[] {
  return Object.values(routeModules).map((mod) => mod.default);
}
