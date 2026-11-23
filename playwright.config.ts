import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 8787);
const portText = String(PORT);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${portText}`;

/**
 * Three projects (S0.1): desktop Chrome, iPhone 14 and Pixel 7 (Android).
 * Set E2E_BASE_URL to test a deployed preview; otherwise the local
 * `wrangler dev` (via @cloudflare/vite-plugin) server is started.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "iPhone", use: { ...devices["iPhone 14"] } },
    { name: "Android", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npm run build && npx wrangler dev --port ${portText} --local`,
        url: `${baseURL}/healthz`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
