import type { OpsEnv } from "./ops/logging";

/** Hono generics shared by every Worker route module. `c.var.logger` and `c.var.requestId` are set for every request. */
export type AppEnv = { Bindings: Cloudflare.Env } & OpsEnv;
