import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// S0.4: navigation, route registration, feature-flag hiding and axe. Runs on
// desktop, iPhone and Android via the playwright.config.ts projects.

async function mockConfig(page: Page, flags: Record<string, boolean>) {
  await page.route("**/api/v1/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ flags }),
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await mockConfig(page, { events: true, money: true, inbox: true });
});

test("bottom nav reaches every primary destination", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav).toBeVisible();

  for (const label of ["Home", "Events", "Money", "Inbox", "More"]) {
    await expect(
      nav
        .getByRole("link", { name: new RegExp(label) })
        .or(nav.getByRole("button", { name: new RegExp(label) })),
    ).toBeVisible();
  }

  await nav.getByRole("button", { name: /More/ }).click();
  await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
});

test("the probe route registers and renders inside the shell with a back control", async ({
  page,
}) => {
  await page.goto("/probe");
  await expect(page.getByTestId("probe-route")).toBeVisible();
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
});

test("a disabled feature flag hides its nav entry", async ({ page }) => {
  await mockConfig(page, { events: false, money: true, inbox: true });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: /Money/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Events/ })).toHaveCount(0);
});

test("the shell has no serious or critical axe violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
