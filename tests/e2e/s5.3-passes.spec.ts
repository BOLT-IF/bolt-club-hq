import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const offersResponse = {
  offers: [
    {
      seriesId: "ser_1",
      seriesName: "Thursday XD",
      termId: "t1",
      termName: "Spring 2027",
      format: "XD",
      weekday: 4,
      startTime: "19:00",
      durationMin: 90,
      location: "Hall A",
      passPrice: 1800,
      priceSek: 900,
      remainingEvents: 6,
      totalEvents: 12,
      passCap: 16,
      passesSold: 10,
      seatsRemaining: 6,
      alreadyOwned: false,
      termsNotice: "Covers up to 6 sessions; no refunds; cancelled nights not compensated.",
    },
  ],
  passes: [],
};

const balancesResponse = {
  members: [
    {
      id: "m2",
      displayName: "Bo Berg",
      paymentRef: "BC-BO",
      status: "active",
      balanceSek: 1800,
      owedSek: 1800,
      creditSek: 0,
    },
    {
      id: "m3",
      displayName: "Cy Dahl",
      paymentRef: "BC-CY",
      status: "active",
      balanceSek: 120,
      owedSek: 120,
      creditSek: 0,
    },
  ],
};

const adminPassesResponse = {
  passes: [
    {
      id: "pas_rev",
      memberId: "m2",
      memberName: "Bo Berg",
      paymentRef: "BC-BO",
      seriesId: "ser_1",
      seriesName: "Thursday XD",
      termName: "Spring 2027",
      priceCharged: 1800,
      eventsCovered: 12,
      purchasedAt: "2027-01-01T10:00:00.000Z",
      chargeStatus: "unpaid",
      unpaidSek: 1800,
      daysElapsed: 25,
      revocable: true,
    },
  ],
};

async function mockPassesApi(page: Page) {
  let bought = false;
  let revoked = false;
  const reply = (status: number, body: unknown) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route("**/api/v1/config", (route) =>
    route.fulfill(reply(200, { flags: { events: true, money: true, inbox: true } })),
  );
  await page.route("**/api/v1/passes/offers", (route) => {
    if (!bought) return route.fulfill(reply(200, offersResponse));
    return route.fulfill(
      reply(200, {
        offers: [
          { ...offersResponse.offers[0], passesSold: 11, seatsRemaining: 5, alreadyOwned: true },
        ],
        passes: [
          {
            id: "pas_new",
            seriesId: "ser_1",
            seriesName: "Thursday XD",
            termName: "Spring 2027",
            priceCharged: 900,
            eventsCovered: 6,
            status: "active",
            purchasedAt: "2027-03-01T10:00:00.000Z",
            revokedAt: null,
          },
        ],
      }),
    );
  });
  await page.route("**/api/v1/passes", (route) => {
    if (route.request().method() === "POST") {
      bought = true;
      return route.fulfill(
        reply(201, {
          pass: {
            id: "pas_new",
            seriesId: "ser_1",
            seriesName: "Thursday XD",
            termName: "Spring 2027",
            priceCharged: 900,
            eventsCovered: 6,
            status: "active",
            purchasedAt: "2027-03-01T10:00:00.000Z",
            revokedAt: null,
          },
          upgradedRsvps: 0,
        }),
      );
    }
    return route.continue();
  });
  await page.route("**/api/v1/admin/balances", (route) =>
    route.fulfill(
      reply(
        200,
        revoked
          ? {
              members: [
                { ...balancesResponse.members[0], balanceSek: 0, owedSek: 0 },
                balancesResponse.members[1],
              ],
            }
          : balancesResponse,
      ),
    ),
  );
  await page.route("**/api/v1/admin/passes", (route) =>
    route.fulfill(reply(200, revoked ? { passes: [] } : adminPassesResponse)),
  );
  await page.route("**/api/v1/admin/passes/pas_rev/revoke", (route) => {
    revoked = true;
    return route.fulfill(
      reply(200, {
        pass: { id: "pas_rev", status: "revoked", revokedAt: "2027-01-26T10:00:00.000Z" },
        reversalEntryId: "led_r1",
        downgradedRsvps: 1,
      }),
    );
  });
}

test("member sees prorated offer and terms notice before purchasing a pass", async ({ page }) => {
  await mockPassesApi(page);
  await page.goto("/money/passes");
  await expect(page.getByText("Thursday XD")).toBeVisible();
  await expect(page.getByText("900 kr")).toBeVisible();
  await expect(
    page.getByText("Covers up to 6 sessions; no refunds; cancelled nights not compensated."),
  ).toBeVisible();

  await page.getByRole("button", { name: /buy pass/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Covers up to 6 sessions; no refunds; cancelled nights not compensated.",
  );
  await dialog.getByRole("button", { name: /confirm purchase/i }).click();
  await expect(page.getByText("You hold a pass")).toBeVisible();
});

test("admin filters revocable passes and revokes one", async ({ page }) => {
  await mockPassesApi(page);
  await page.goto("/admin/money");
  await expect(page.getByText("Bo Berg")).toBeVisible();
  await page.getByRole("radio", { name: /revocable/i }).click();
  const list = page.getByRole("list", { name: /balances/i });
  await expect(list).toContainText("Bo Berg");
  await expect(list).not.toContainText("Cy Dahl");

  await list.getByRole("button", { name: /revoke pass/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /confirm revocation/i }).click();
  await expect(page.getByText("No Revocable Passes")).toBeVisible();
});

test("passes screen has no serious or critical axe violations", async ({ page }) => {
  await mockPassesApi(page);
  await page.goto("/money/passes");
  await expect(page.getByText("Thursday XD")).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
