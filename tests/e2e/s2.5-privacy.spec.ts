import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Block the service worker so WebKit/iPhone does not bypass page.route() after clients.claim().
test.use({ serviceWorkers: "block" });

async function mockConfig(page: Page, privacy = true) {
  await page.route("**/api/v1/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ flags: { events: true, money: true, inbox: true, privacy } }),
    }),
  );
}

test("privacy entry is hidden in More and /privacy shows disabled state when FLAG_PRIVACY is off", async ({
  page,
}) => {
  await mockConfig(page, false);
  await page.goto("/");
  await page.getByRole("button", { name: /More/ }).click();
  await expect(page.getByRole("link", { name: "Privacy" })).toHaveCount(0);

  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "Privacy Screen Isn't Enabled" })).toBeVisible();
  await expect(page.getByRole("button", { name: /download my data/i })).toHaveCount(0);
});

test("privacy page is reachable from More, renders notice, downloads export, and passes axe", async ({
  page,
  browserName,
}) => {
  await mockConfig(page);
  await page.route("**/api/v1/me/export", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        exportedAt: "2027-06-01T12:00:00.000Z",
        member: { id: "mem_1", displayName: "Ada Lovelace", email: "ada@example.com" },
        ledgerEntries: [],
      }),
    }),
  );

  await page.goto("/");
  await page.getByRole("button", { name: /More/ }).click();
  await page.getByRole("link", { name: "Privacy" }).click();

  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { name: "Privacy" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
  await expect(page.getByText(/7 years/i)).toBeVisible();

  const exportResponsePromise = page.waitForResponse(
    (res) => res.url().includes("/api/v1/me/export") && res.status() === 200,
  );
  // WebKit/iOS does not reliably emit Playwright's `download` event for blob: <a download> links.
  const downloadPromise = browserName === "webkit" ? null : page.waitForEvent("download");
  await page.getByRole("button", { name: /download my data/i }).click();
  await exportResponsePromise;
  if (downloadPromise) {
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("bolt-hq-data-export.json");
  }
  await expect(page.getByText("Your data export is ready.")).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
