import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const reply = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function setupConfig(page: Page) {
  await page.route("**/api/v1/config", (route) =>
    route.fulfill(reply(200, { flags: { events: true, money: true, inbox: true } })),
  );
  await page.route("**/api/v1/notifications", (route) =>
    route.fulfill(reply(200, { items: [], unreadCount: 0 })),
  );
}

test("member submits a payment claim and sees rejected reason in their list", async ({ page }) => {
  await setupConfig(page);
  const claims: Array<{
    id: string;
    memberId: string;
    amountSek: number;
    paidOn: string;
    note: string | null;
    status: string;
    decidedAt: string | null;
    rejectReason: string | null;
  }> = [
    {
      id: "clm_prev",
      memberId: "mem_1",
      amountSek: 120,
      paidOn: "2026-11-10",
      note: null,
      status: "rejected",
      decidedAt: "2026-11-11T10:00:00Z",
      rejectReason: "No transfer found",
    },
  ];
  let idempotencyKey: string | null = null;

  await page.route("**/api/v1/me/payment-claims", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill(reply(200, { claims }));
    }
    idempotencyKey = route.request().headers()["idempotency-key"] ?? null;
    const body = route.request().postDataJSON() as {
      amountSek: number;
      paidOn: string;
      note?: string;
    };
    const created = {
      id: "clm_new",
      memberId: "mem_1",
      amountSek: body.amountSek,
      paidOn: body.paidOn,
      note: body.note ?? null,
      status: "pending",
      decidedAt: null,
      rejectReason: null,
    };
    claims.unshift(created);
    return route.fulfill(reply(201, created));
  });

  await page.goto("/money/claims");
  await expect(page.getByText("No transfer found")).toBeVisible();

  await page.getByLabel("Amount (kr)").fill("300");
  await page.getByLabel("Date paid").fill("2026-11-20");
  await page.getByLabel("Note (optional)").fill("Swish");
  await page.getByRole("button", { name: "Submit claim" }).click();

  await expect(page.getByText("300 kr")).toBeVisible();
  expect(idempotencyKey).toBeTruthy();

  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test("admin confirms a member claim, rejects another with reason, and cannot decide own claim", async ({
  page,
}) => {
  await setupConfig(page);
  let queue = [
    {
      id: "clm_bo",
      memberId: "mem_bo",
      amountSek: 240,
      paidOn: "2027-02-20",
      note: "Swish",
      status: "pending",
      decidedAt: null,
      rejectReason: null,
      displayName: "Bo Berg",
      paymentRef: "BOLT-BO",
      balanceSek: 240,
      isOwn: false,
    },
    {
      id: "clm_cy",
      memberId: "mem_cy",
      amountSek: 150,
      paidOn: "2027-02-21",
      note: null,
      status: "pending",
      decidedAt: null,
      rejectReason: null,
      displayName: "Cy Dahl",
      paymentRef: "BOLT-CY",
      balanceSek: 150,
      isOwn: false,
    },
    {
      id: "clm_own",
      memberId: "mem_ada",
      amountSek: 90,
      paidOn: "2027-02-22",
      note: null,
      status: "pending",
      decidedAt: null,
      rejectReason: null,
      displayName: "Ada Admin",
      paymentRef: "BOLT-ADA",
      balanceSek: 90,
      isOwn: true,
    },
  ];
  let confirmKey: string | null = null;
  let rejectKey: string | null = null;

  await page.route("**/api/v1/admin/payment-claims", (route) =>
    route.fulfill(reply(200, { claims: queue })),
  );
  await page.route("**/api/v1/admin/payment-claims/clm_bo/confirm", (route) => {
    confirmKey = route.request().headers()["idempotency-key"] ?? null;
    queue = queue.filter((c) => c.id !== "clm_bo");
    return route.fulfill(reply(200, { claimId: "clm_bo", status: "confirmed", entryId: "led_1" }));
  });
  await page.route("**/api/v1/admin/payment-claims/clm_cy/reject", (route) => {
    rejectKey = route.request().headers()["idempotency-key"] ?? null;
    queue = queue.filter((c) => c.id !== "clm_cy");
    return route.fulfill(reply(200, { claimId: "clm_cy", status: "rejected" }));
  });

  await page.goto("/admin/money/claims");
  const list = page.getByRole("list", { name: "Pending payment claims" });
  await expect(list.getByRole("listitem")).toHaveCount(3);

  const ownRow = list.getByRole("listitem").filter({ hasText: "Ada Admin" });
  await expect(ownRow).toContainText("Your claim");
  await expect(ownRow.getByRole("button", { name: /confirm/i })).toBeDisabled();
  await expect(ownRow.getByRole("button", { name: /reject/i })).toBeDisabled();

  await page.getByRole("button", { name: /confirm Bo Berg/i }).click();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  expect(confirmKey).toBeTruthy();

  await page.getByRole("button", { name: /reject Cy Dahl/i }).click();
  await page.getByLabel("Reason").fill("Wrong reference");
  await page.getByRole("button", { name: "Reject claim" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  expect(rejectKey).toBeTruthy();

  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
