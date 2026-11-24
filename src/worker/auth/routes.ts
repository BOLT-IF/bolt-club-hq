import { Hono } from "hono";

import { configureRequestDeps, contextMiddleware } from "../core/context";
import type { AppEnv } from "../types";
import { requireSignedIn } from "./guard";
import { originGuard } from "./origin";
import { clerkRequestDeps } from "./wiring";

// Production wiring (S1.1): Clerk JWT verification and pending-member creation replace
// the default request deps. Tests call configureRequestDeps themselves.
configureRequestDeps(clerkRequestDeps());

/**
 * Auth area. `GET /me` answers "who am I" for any signed-in user, pending ones included
 * (the join waiting screen reads it). Clerk handles sign-in and sign-out client-side.
 */
export default new Hono<AppEnv>()
  // Origin check for state-changing requests. Hono applies "*" to routes registered after
  // this module, so it only covers areas that sort after "auth"; see DECISIONS (S1.1).
  .use("*", originGuard())
  .use("/me", contextMiddleware())
  .get("/me", requireSignedIn(), (c) => c.json(c.var.actor));
