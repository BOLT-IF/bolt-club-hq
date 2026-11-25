import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const reply = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mockSignedInAdmin(page: Page) {
  await page.route("**/api/v1/**", (route) => route.fulfill(reply(200, {})));
  await page.route("**/api/v1/config", (route) =>
    route.fulfill(reply(200, { flags: { events: true, money: true, inbox: true, polls: true } })),
  );
  await page.route("**/api/v1/me", (route) =>
    route.fulfill(
      reply(200, {
        id: "mem_admin",
        displayName: "Admin User",
        role: "admin",
        status: "active",
        paymentRef: "BC-ADMIN",
      }),
    ),
  );
  await page.route("**/api/v1/me/profile", (route) =>
    route.fulfill(
      reply(200, {
        id: "mem_admin",
        displayName: "Admin User",
        rosterName: "Admin",
        email: "admin@boltif.eu",
        paymentRef: "BC-ADMIN",
      }),
    ),
  );
  await page.route("**/api/v1/notifications", (route) =>
    route.fulfill(reply(200, { items: [], unreadCount: 0 })),
  );
  await page.route("**/api/v1/notifications/prefs", (route) =>
    route.fulfill(
      reply(200, {
        globalMute: false,
        categories: [{ category: "rsvp_status", muted: false }],
      }),
    ),
  );
  await page.route("**/api/v1/events/oneoff/options", (route) =>
    route.fulfill(reply(200, { canSetFee: true })),
  );
  await page.route("**/api/v1/events{,?*}", (route) => route.fulfill(reply(200, { events: [] })));
  await page.route("**/api/v1/me/ledger", (route) =>
    route.fulfill(reply(200, { balanceSek: 0, owedSek: 0, creditSek: 0, items: [] })),
  );
  await page.route("**/api/v1/me/payment-claims", (route) =>
    route.fulfill(reply(200, { claims: [] })),
  );
  await page.route("**/api/v1/passes/offers", (route) =>
    route.fulfill(reply(200, { offers: [], passes: [] })),
  );
  await page.route("**/api/v1/polls", (route) => route.fulfill(reply(200, { polls: [] })));
  await page.route("**/api/v1/admin/join-requests", (route) =>
    route.fulfill(reply(200, { requests: [] })),
  );
  await page.route("**/api/v1/admin/payment-claims", (route) =>
    route.fulfill(reply(200, { claims: [] })),
  );
}

test("More sheet shows Admin and Sign out for signed-in admin, and hides Install in standalone mode", async ({
  page,
}) => {
  await mockSignedInAdmin(page);
  await page.addInitScript(`
    const orig = window.matchMedia.bind(window);
    window.matchMedia = (q) =>
      q === "(display-mode: standalone)"
        ? {
            matches: true,
            media: q,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          }
        : orig(q);
  `);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: /More/ })
    .click();
  const sheet = page.getByRole("dialog", { name: "More" });
  await expect(sheet.getByRole("link", { name: "Admin" })).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Sign out" })).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Install the app" })).toHaveCount(0);

  await sheet.getByRole("link", { name: "Admin" }).click();
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Members" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Invites & join requests" })).toBeVisible();
});

test("Notifications settings includes device push section and mute switches", async ({ page }) => {
  await mockSignedInAdmin(page);
  await page.goto("/settings/notifications");
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Push on this device" })).toBeVisible();
  await expect(page.getByText("Mute all notifications")).toBeVisible();
});

test("core mobile routes have zero horizontal overflow (including /events/new)", async ({
  page,
}) => {
  await mockSignedInAdmin(page);
  const routes = ["/", "/events/new", "/profile", "/settings/notifications", "/money", "/privacy"];
  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator("#main")).toBeVisible();
    // Wait for async page content (e.g. NewEventPage form options) to render before measuring.
    if (route === "/events/new") {
      await expect(page.getByRole("heading", { name: "New event" })).toBeVisible();
    }
    const overflow = await page.evaluate<number>(
      "document.documentElement.scrollWidth - window.innerWidth",
    );
    expect(overflow, `Horizontal overflow on ${route}`).toBeLessThanOrEqual(0);
  }
});
