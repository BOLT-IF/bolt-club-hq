import { createApp } from "./app";
import { systemClock } from "./core/clock";
import { cronHooksFor } from "./core/cron";
import { recordTick } from "./ops/health";
import { createSentryReporter } from "./ops/sentry";

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
   * Cron Triggers (wrangler.jsonc). Records the tick first, so `/healthz/ready` sees
   * the cron is alive even when a hook fails, then runs the hooks registered for
   * this cron. A failing hook does not stop the others; the first error is rethrown
   * so Cloudflare marks the run as failed.
   */
  async scheduled(controller: ScheduledController, env: Cloudflare.Env): Promise<void> {
    await recordTick(env.KV, systemClock);
    const results = await Promise.allSettled(
      cronHooksFor(controller.cron).map((hook) =>
        hook({ scheduledAt: new Date(controller.scheduledTime), cron: controller.cron }),
      ),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  },
} satisfies ExportedHandler<Cloudflare.Env>;
