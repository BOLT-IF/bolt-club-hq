import { expect, test } from "@playwright/test";

test("serves /healthz and the SPA from the same origin", async ({ page, request, baseURL }) => {
  const health = await request.get("/healthz");
  expect(health.ok()).toBe(true);
  expect(await health.json()).toMatchObject({ status: "ok" });

  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
});
