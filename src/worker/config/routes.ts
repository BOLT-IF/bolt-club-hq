import { Hono } from "hono";

import type { AppEnv } from "../types";
import { flagsFromEnv } from "./flags";

/**
 * Public client config (PLAN §11.6 `GET /config`). Unauthenticated on purpose: the
 * shell needs the flags before sign-in. S2.3 adds the public ClubSettings subset here.
 */
export default new Hono<AppEnv>().get("/config", (c) =>
  c.json({ flags: flagsFromEnv(c.env as unknown as Record<string, unknown>) }),
);
