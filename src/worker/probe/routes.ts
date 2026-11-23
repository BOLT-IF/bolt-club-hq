import { Hono } from "hono";

import type { AppEnv } from "../types";

// Probe route proving backend auto-registration (S0.1). Remove once real routes exist.
export default new Hono<AppEnv>().get("/probe", (c) => c.json({ probe: "ok" }));
