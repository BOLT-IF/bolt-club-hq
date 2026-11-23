import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * Three Vitest projects (S0.1):
 * - domain: pure TypeScript, node environment.
 * - worker: Workers runtime via @cloudflare/vitest-pool-workers (needs Postgres in S0.2+).
 * - ui: React components under jsdom.
 */
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "domain",
          include: ["src/domain/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { ENV: "test" } },
          }),
        ],
        test: {
          name: "worker",
          include: ["src/worker/**/*.test.ts"],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "ui",
          include: ["src/app/**/*.test.{ts,tsx}"],
          environment: "jsdom",
        },
      },
    ],
  },
});
