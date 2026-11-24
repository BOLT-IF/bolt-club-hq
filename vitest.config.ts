import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/** Suites that need real Postgres through `pg`; they run in the plain-Node db project. */
const DB_SUITES = [
  "src/worker/core/db/migration.test.ts",
  "src/worker/core/ledger.test.ts",
  "src/worker/core/idempotency.test.ts",
  "src/worker/core/locking.test.ts",
  "src/worker/core/context.test.ts",
  // Feature areas: name a Postgres-backed suite *.db.test.ts and it runs here (W2 contract).
  "src/worker/**/*.db.test.ts",
];

/**
 * Four Vitest projects:
 * - domain: pure TypeScript, node environment.
 * - worker: Workers runtime via @cloudflare/vitest-pool-workers (runtime semantics only).
 * - db: plain Node against real Postgres via DATABASE_URL (migrations, ledger trigger,
 *   idempotency, row locking). Outside the workerd pool because
 *   @cloudflare/vitest-pool-workers 0.23 cannot load pg's CJS chain (docs/ops/db.md).
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
          exclude: [...DB_SUITES],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: DB_SUITES,
          environment: "node",
          fileParallelism: false,
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "ui",
          include: ["src/app/**/*.test.{ts,tsx}", "src/sw/**/*.test.ts"],
          environment: "jsdom",
        },
      },
    ],
  },
});
