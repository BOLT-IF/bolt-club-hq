import { createApp } from "./app";
import { createSentryReporter } from "./ops/sentry";
import { runScheduled } from "./scheduler/run";

const app = createApp();

app.onError((error, c) => {
  // SENTRY_DSN is an optional secret, so it is not in the generated Env type.
  const dsn: unknown = Reflect.get(c.env, "SENTRY_DSN");
  const report = createSentryReporter(typeof dsn === "string" ? { SENTRY_DSN: dsn } : {}, {
    environment: c.env.ENV,
  });
  if (report) c.executionCtx.waitUntil(report(error));
  c.var.logger.error("request.failed", { message: String(error) });
  return c.json({ error: "internal" }, 500);
});

/**
 * One origin for everything. `/healthz*` and `/api/*` run in the Worker; every
 * other request is served from the static assets binding, which falls back to
 * index.html for client-side routes (see wrangler.jsonc `assets`).
 */
export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/healthz") || pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  /**
   * Cron Triggers (wrangler.jsonc). The scheduler (src/worker/scheduler/run.ts) records
   * the tick, takes the overlap lock, runs the hooks only when `next_due_at` says work
   * is due, and rethrows the first failure so Cloudflare marks the run as failed.
   */
  async scheduled(controller: ScheduledController, env: Cloudflare.Env): Promise<void> {
    await runScheduled(controller, env);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
