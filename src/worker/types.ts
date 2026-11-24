import type { AppVariables } from "./core/context";
import type { OpsVariables } from "./ops/logging";

/**
 * Hono generics shared by every Worker route module. `c.var.logger` and `c.var.requestId`
 * are set for every request; `c.var.db`, `c.var.clock` and `c.var.actor` are set once the
 * area mounts `contextMiddleware()` (src/worker/core/context.ts).
 */
export type AppEnv = { Bindings: Cloudflare.Env; Variables: OpsVariables & AppVariables };
