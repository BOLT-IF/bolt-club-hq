import { createApp } from "./app";

const app = createApp();

/**
 * One origin for everything. `/healthz` and `/api/*` run in the Worker; every
 * other request is served from the static assets binding, which falls back to
 * index.html for client-side routes (see wrangler.jsonc `assets`).
 */
export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz" || pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
