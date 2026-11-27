import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// S5.2: the member Money screen. The API is mocked with page.route (like shell.spec.ts).
// The server-side "another member's ledger is 403" rule is covered against Postgres in
// src/worker/ledger/routes.db.test.ts (S5.1); here we check the screen never asks for
// anyone else's ledger and handles a 403.

interface Mock {
  ledger?: { status: number; body: unknown };
}

const ownLedger = {
  balanceSek: 90,
  owedSek: 90,
  creditSek: 0,
  items: [
    {
      id: "led_c1",
      kind: "charge",
      reason: "adhoc",
      amountSek: 120,
      status: "paid",
      allocatedSek: 120,
      outstandingSek: 0,
      note: null,
      createdAt: "2027-01-14T20:00:00.000Z",
      reversesEntryId: null,
      passId: null,
      eventId: "ev1",
      eventTitle: "Thursday XD",
      eventStartsAt: "2027-01-14T18:00:00.000Z",
      guestId: null,
      guestName: null,
    },
    {
      id: "led_c2",
      kind: "charge",
      reason: "guest",
      amountSek: 120,
      status: "partly_paid",
      allocatedSek: 30,
      outstandingSek: 90,
      note: null,
      createdAt: "2027-01-14T20:00:01.000Z",
      reversesEntryId: null,
      passId: null,
      eventId: "ev1",
      eventTitle: "Thursday XD",
      eventStartsAt: "2027-01-14T18:00:00.000Z",
      guestId: "g1",
      guestName: "Sam Guest",
    },
    {
      id: "led_p1",
      kind: "payment",
      reason: "payment",
      amountSek: -150,
      status: "applied",
      allocatedSek: 150,
      outstandingSek: 0,
      note: null,
      createdAt: "2027-01-15T09:00:00.000Z",
      reversesEntryId: null,
      passId: null,
      eventId: null,
      eventTitle: null,
      eventStartsAt: null,
      guestId: null,
      guestName: null,
    },
  ],
};

async function mockApi(page: Page, mock: Mock = {}): Promise<string[]> {
  const ledgerUrls: string[] = [];
  const reply = (status: number, body: unknown) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route("**/api/v1/config", (route) =>
    route.fulfill(reply(200, { flags: { events: true, money: true, inbox: true } })),
  );
  await page.route("**/api/v1/me/ledger**", (route) => {
    ledgerUrls.push(route.request().url());
    const { status, body } = mock.ledger ?? { status: 200, body: ownLedger };
    return route.fulfill(reply(status, body));
  });
  await page.route("**/api/v1/settings/public", (route) =>
    route.fulfill(
      reply(200, {
        clubName: "BOLT IF",
        bank: { accountHolder: "BOLT IF", bankgiro: "5050-1055" },
        paymentInstructions: "Pay within 14 days.",
        quietHours: null,
        rosterAppUrl: null,
      }),
    ),
  );
  await page.route("**/api/v1/me/profile", (route) =>
    route.fulfill(
      reply(200, {
        id: "mem_1",
        displayName: "Alex",
        rosterName: null,
        email: "a@x",
        paymentRef: "BOLT-ALEX",
      }),
    ),
  );
  return ledgerUrls;
}

test("a member sees only their own entries", async ({ page }) => {
  const ledgerUrls = await mockApi(page);
  await page.goto("/money");
  await expect(page.getByText("90 kr", { exact: true })).toBeVisible();
  await expect(page.getByText("Balance Due")).toBeVisible();
  await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "Ledger entries" }).getByRole("listitem"),
  ).toHaveCount(3);
  expect(ledgerUrls.length).toBeGreaterThan(0);
  for (const url of ledgerUrls) expect(new URL(url).search).toBe("");
});

test("items show the event date and guest name", async ({ page }) => {
  await mockApi(page);
  await page.goto("/money");
  const guestRow = page
    .getByRole("list", { name: "Ledger entries" })
    .getByRole("listitem")
    .filter({ hasText: "Guest fee" });
  await expect(guestRow).toContainText("Sam Guest");
  await expect(guestRow).toContainText("Thursday XD");
  await expect(guestRow).toContainText("Thu 14 Jan");
  await expect(guestRow).toContainText("Partly paid, 90 kr left");
});

test("credit displays correctly", async ({ page }) => {
  await mockApi(page, {
    ledger: {
      status: 200,
      body: {
        balanceSek: -100,
        owedSek: 0,
        creditSek: 100,
        items: [
          {
            ...ownLedger.items[2],
            amountSek: -100,
            status: "unapplied",
            allocatedSek: 0,
            outstandingSek: 100,
          },
        ],
      },
    },
  });
  await page.goto("/money");
  await expect(page.getByText("100 kr", { exact: true })).toBeVisible();
  await expect(page.getByText("Credit", { exact: true })).toBeVisible();
  await expect(page.getByText("Balance Due")).toHaveCount(0);
});

test("shows how to pay with the payment reference", async ({ page }) => {
  await mockApi(page);
  await page.goto("/money");
  const howTo = page.getByRole("region", { name: "How to Pay" });
  await expect(howTo).toContainText("5050-1055");
  await expect(howTo).toContainText("BOLT-ALEX");
  await expect(howTo.getByRole("button", { name: "Copy payment reference" })).toBeVisible();
});

test("a 403 from the ledger shows an error, not someone else's data", async ({ page }) => {
  await mockApi(page, { ledger: { status: 403, body: { error: "forbidden" } } });
  await page.goto("/money");
  await expect(page.getByRole("alert")).toContainText("only see your own");
  await expect(page.getByRole("list", { name: "Ledger entries" })).toHaveCount(0);
});

test("the money screen has no serious or critical axe violations", async ({ page }) => {
  await mockApi(page);
  await page.goto("/money");
  await expect(page.getByText("90 kr", { exact: true })).toBeVisible();
  await expect(page.getByText("BOLT-ALEX")).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
