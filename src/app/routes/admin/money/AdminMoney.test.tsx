import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../api/client";
import { ToastProvider } from "../../../components/ui/Toast";
import { FeatureFlagsProvider } from "../../../lib/flags";
import { registeredFrontendRoutes } from "../../registry";
import { AdminBalances } from "./AdminBalances";
import { AdminClubFees } from "./AdminClubFees";
import { AdminMemberLedger } from "./AdminMemberLedger";

const bo = {
  id: "m2",
  displayName: "Bo Berg",
  paymentRef: "BC-BO",
  status: "active",
  balanceSek: 240,
  owedSek: 240,
  creditSek: 0,
};
const cy = {
  id: "m3",
  displayName: "Cy Dahl",
  paymentRef: "BC-CY",
  status: "inactive",
  balanceSek: 90,
  owedSek: 90,
  creditSek: 0,
};
const di = {
  id: "m4",
  displayName: "Di Ek",
  paymentRef: "BC-DI",
  status: "active",
  balanceSek: -100,
  owedSek: 0,
  creditSek: 100,
};

const detail = {
  member: { id: "m2", displayName: "Bo Berg", paymentRef: "BC-BO", status: "active" },
  balanceSek: 240,
  owedSek: 240,
  creditSek: 0,
  items: [
    {
      id: "led_c1",
      kind: "charge",
      reason: "adhoc",
      amountSek: 120,
      status: "unpaid",
      allocatedSek: 0,
      outstandingSek: 120,
      note: "",
      createdAt: "2027-01-10T10:00:00.000Z",
      reversesEntryId: null,
      eventTitle: "Thursday XD",
      eventStartsAt: "2027-01-14T18:00:00.000Z",
      waivable: true,
      reversible: true,
    },
    {
      id: "led_c2",
      kind: "charge",
      reason: "guest",
      amountSek: 120,
      status: "unpaid",
      allocatedSek: 0,
      outstandingSek: 120,
      note: "",
      createdAt: "2027-01-11T10:00:00.000Z",
      reversesEntryId: null,
      eventTitle: null,
      eventStartsAt: null,
      waivable: true,
      reversible: true,
    },
  ],
};

const offerRegular = {
  seriesId: "ser_thu",
  seriesName: "Thursday XD",
  termId: "term_1",
  termName: "Spring 2027",
  format: "Mixed Doubles",
  weekday: 4,
  startTime: "19:00",
  durationMin: 90,
  location: "Hall A",
  passPrice: 1200,
  regularPassPrice: 1200,
  discounted: false,
  priceSek: 1200,
  remainingEvents: 10,
  totalEvents: 10,
  passCap: 12,
  passesSold: 4,
  seatsRemaining: 8,
  alreadyOwned: false,
  termsNotice: "Covers up to 10 sessions; no refunds; cancelled nights not compensated.",
};

const offerDiscounted = {
  ...offerRegular,
  seriesId: "ser_tue",
  seriesName: "Tuesday MD",
  weekday: 2,
  passPrice: 1000,
  regularPassPrice: 1200,
  discounted: true,
  priceSek: 1000,
  remainingEvents: 8,
  totalEvents: 10,
  passCap: 10,
  passesSold: 7,
  seatsRemaining: 3,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  method: string;
  path: string;
  body: unknown;
  key: string | null;
}

const clubFeesData = {
  clubYear: 2026,
  label: "2026/2027",
  fallFeeSek: 160,
  springFeeSek: 85,
  availableYears: [2026, 2025],
  summary: {
    totalMembers: 4,
    paidFallCount: 2,
    paidFallInAppCount: 1,
    paidFallExternalCount: 1,
    owesFallCount: 0,
    springCount: 1,
    paidSpringCount: 0,
    owesSpringCount: 1,
    exemptCount: 0,
    notChargedCount: 1,
  },
  members: [
    {
      memberId: "m1",
      displayName: "Ada Fall",
      paymentRef: "BC-ADA",
      memberStatus: "active",
      status: "paid_fall",
      season: "fall",
      kind: "charged",
      paidInFall: true,
      ledgerEntryId: "led_cf1",
      clubFeeId: "cf_1",
      amountSek: 160,
      oweAmountSek: 0,
      note: "Club fee — Fall 2026/2027",
      recordedAt: "2026-09-01T10:00:00.000Z",
    },
    {
      memberId: "m2",
      displayName: "Bo External",
      paymentRef: "BC-BO",
      memberStatus: "active",
      status: "paid_fall_external",
      season: "fall",
      kind: "external_fall_paid",
      paidInFall: true,
      ledgerEntryId: null,
      clubFeeId: "cf_2",
      amountSek: 0,
      oweAmountSek: 0,
      note: "Paid Fall club fee outside app",
      recordedAt: "2026-09-02T10:00:00.000Z",
    },
    {
      memberId: "m3",
      displayName: "Cy Spring",
      paymentRef: "BC-CY",
      memberStatus: "active",
      status: "charged_spring_unpaid",
      season: "spring",
      kind: "charged",
      paidInFall: false,
      ledgerEntryId: "led_cf3",
      clubFeeId: "cf_3",
      amountSek: 85,
      oweAmountSek: 85,
      note: "Club fee — Spring 2026/2027",
      recordedAt: "2027-01-10T10:00:00.000Z",
    },
    {
      memberId: "m4",
      displayName: "Di Uncharged",
      paymentRef: "BC-DI",
      memberStatus: "active",
      status: "not_charged",
      season: null,
      kind: null,
      paidInFall: false,
      ledgerEntryId: null,
      clubFeeId: null,
      amountSek: 0,
      oweAmountSek: 0,
      note: "",
      recordedAt: null,
    },
  ],
};

function stub(
  post: (path: string, body: unknown) => Response = () => json(201, {}),
  offersByMember: Record<string, unknown[]> = {
    m2: [offerDiscounted, offerRegular],
    m4: [offerRegular],
  },
) {
  const calls: Call[] = [];
  configureApiClient({
    fetch: vi.fn((input: string, init?: RequestInit) => {
      const path = input.replace("/api/v1", "");
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const key = new Headers(init?.headers).get("Idempotency-Key");
      calls.push({ method, path, body, key });
      if (method === "GET" && path === "/admin/balances")
        return Promise.resolve(json(200, { members: [bo, cy, di] }));
      if (method === "GET" && path === "/admin/passes")
        return Promise.resolve(json(200, { passes: [] }));
      if (method === "GET" && path === "/admin/balances/m2")
        return Promise.resolve(json(200, detail));
      if (method === "GET" && path.startsWith("/admin/passes/offers")) {
        const url = new URL(path, "http://localhost");
        const memberId = url.searchParams.get("memberId") ?? "";
        return Promise.resolve(json(200, { offers: offersByMember[memberId] ?? [] }));
      }
      if (method === "GET" && path.startsWith("/admin/club-fees"))
        return Promise.resolve(json(200, clubFeesData));
      return Promise.resolve(post(path, body));
    }),
  });
  return calls;
}

function renderWith(node: React.ReactNode, money = true) {
  render(
    <FeatureFlagsProvider flags={{ money }}>
      <ToastProvider>{node}</ToastProvider>
    </FeatureFlagsProvider>,
  );
}

beforeEach(() => {
  window.history.pushState({}, "", "/admin/money");
});
afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("admin money routes", () => {
  it("registers the balances, club fees, and member ledger pages", () => {
    const paths = registeredFrontendRoutes().map((r) => r.path);
    expect(paths).toContain("/admin/money");
    expect(paths).toContain("/admin/money/club-fees");
    expect(paths).toContain("/admin/money/members/:id");
  });
});

describe("balances page", () => {
  it("is hidden while the money flag is off", () => {
    stub();
    renderWith(<AdminBalances />, false);
    expect(screen.getByText(/not switched on yet/i)).toBeTruthy();
  });

  it("lists balances with owed and credit as words, and searches by name or payment reference", async () => {
    stub();
    renderWith(<AdminBalances />);
    const list = await screen.findByRole("list", { name: /balances/i });
    expect(screen.getByRole("link", { name: "Payment Claims" }).getAttribute("href")).toBe(
      "/admin/money/claims",
    );
    expect(screen.getByRole("link", { name: "Club Fees" }).getAttribute("href")).toBe(
      "/admin/money/club-fees",
    );
    expect(within(list).getByText("Bo Berg")).toBeTruthy();
    expect(within(list).getByText(/owes 240 kr/i)).toBeTruthy();
    expect(within(list).getByText(/credit 100 kr/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/search/i), { target: { value: "bc-cy" } });
    expect(within(list).queryByText("Bo Berg")).toBeNull();
    expect(within(list).getByText("Cy Dahl")).toBeTruthy();
  });

  it("filters to inactive members with a balance", async () => {
    stub();
    renderWith(<AdminBalances />);
    await screen.findByText("Bo Berg");
    fireEvent.click(screen.getByRole("radio", { name: /inactive with balance/i }));
    const list = screen.getByRole("list", { name: /balances/i });
    expect(within(list).queryByText("Bo Berg")).toBeNull();
    expect(within(list).getByText("Cy Dahl")).toBeTruthy();
  });

  it("assigns a pass from the balances page after choosing an active member and series", async () => {
    const calls = stub(() => json(201, { pass: { id: "pas_1" }, upgradedRsvps: 0 }));
    renderWith(<AdminBalances />);
    await screen.findByText("Bo Berg");

    fireEvent.click(screen.getByRole("button", { name: /assign pass/i }));
    const dialog = screen.getByRole("dialog", { name: /assign pass/i });

    const memberSelect = within(dialog).getByLabelText(/^member$/i);
    // Inactive member Cy Dahl is excluded from active member options.
    expect(within(memberSelect).queryByText(/Cy Dahl/)).toBeNull();
    expect(within(memberSelect).getByText(/Bo Berg/)).toBeTruthy();
    expect(within(memberSelect).getByText(/Di Ek/)).toBeTruthy();
    // No custom price override input exists.
    expect(within(dialog).queryByLabelText(/price|amount/i)).toBeNull();

    fireEvent.change(memberSelect, { target: { value: "m4" } });
    await within(dialog).findByText(/Thursday XD · Spring 2027/);
    expect(within(dialog).getByText("1200 kr")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: /assign pass \(1200 kr\)/i }));

    await waitFor(() => {
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });
    const post = calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({
      path: "/admin/passes",
      body: { memberId: "m4", seriesId: "ser_thu" },
    });
    expect(post?.key).toBeTruthy();
    expect(await screen.findByText("Assigned pass to Di Ek.")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(calls.filter((c) => c.method === "GET" && c.path === "/admin/balances")).toHaveLength(2);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/admin/passes")).toHaveLength(2);
  });

  it("shows all active pass holders (paid and unpaid) under Pass Holders and only shows Revoke Pass for unpaid passes", async () => {
    configureApiClient({
      fetch: vi.fn((input: string) => {
        const path = input.replace("/api/v1", "");
        if (path === "/admin/balances")
          return Promise.resolve(json(200, { members: [bo, cy, di] }));
        if (path === "/admin/payment-claims") return Promise.resolve(json(200, { claims: [] }));
        if (path === "/admin/passes") {
          return Promise.resolve(
            json(200, {
              passes: [
                {
                  id: "pas_paid",
                  memberId: "m4",
                  memberName: "Di Ek",
                  paymentRef: "BC-DI",
                  seriesId: "ser_thu",
                  seriesName: "Thursday XD",
                  termName: "Spring 2027",
                  priceCharged: 1200,
                  eventsCovered: 10,
                  purchasedAt: "2027-01-01T10:00:00.000Z",
                  chargeStatus: "paid",
                  unpaidSek: 0,
                  daysElapsed: 10,
                  revocable: false,
                },
                {
                  id: "pas_unpaid",
                  memberId: "m2",
                  memberName: "Bo Berg",
                  paymentRef: "BC-BO",
                  seriesId: "ser_mon",
                  seriesName: "Monday MD",
                  termName: "Spring 2027",
                  priceCharged: 900,
                  eventsCovered: 10,
                  purchasedAt: "2027-01-02T10:00:00.000Z",
                  chargeStatus: "unpaid",
                  unpaidSek: 900,
                  daysElapsed: 3,
                  revocable: true,
                },
              ],
            }),
          );
        }
        return Promise.resolve(json(200, {}));
      }),
    });

    renderWith(<AdminBalances />);
    await screen.findByText("Bo Berg");

    fireEvent.click(screen.getByRole("radio", { name: "Pass Holders" }));

    const list = await screen.findByRole("list", { name: "Pass Holders" });
    expect(within(list).getByText("Di Ek")).toBeTruthy();
    expect(within(list).getByText("Paid · 1200 kr")).toBeTruthy();
    expect(within(list).getByText("Bo Berg")).toBeTruthy();
    expect(within(list).getByText("Unpaid 900 kr")).toBeTruthy();
    expect(within(list).getAllByRole("button", { name: "Revoke Pass" })).toHaveLength(1);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Thursday" } });
    expect(within(list).getByText("Di Ek")).toBeTruthy();
    expect(within(list).queryByText("Bo Berg")).toBeNull();
  });
});

describe("member ledger page", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/admin/money/members/m2");
  });

  it("records a payment with whole kronor and an Idempotency-Key, reusing the key on a retry", async () => {
    let attempts = 0;
    const calls = stub(() => {
      attempts += 1;
      return attempts === 1
        ? json(409, { error: "idempotency_key_in_progress" })
        : json(201, { entryId: "led_p", balanceSek: 90 });
    });
    renderWith(<AdminMemberLedger />);
    await screen.findByRole("heading", { name: "Bo Berg" });
    expect(screen.getByText(/owes 240 kr/i)).toBeTruthy();
    expect(screen.getByText(/Thursday XD/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /record payment/i }));
    const amount = screen.getByLabelText(/amount/i);
    fireEvent.change(amount, { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: /save payment/i }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole("button", { name: /save payment/i }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    });

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts[0]).toMatchObject({
      path: "/admin/payments",
      body: { memberId: "m2", amountSek: 150 },
    });
    expect(posts[0]?.key).toBeTruthy();
    expect(posts[1]?.key).toBe(posts[0]?.key);
  });

  it("refuses a fractional amount before calling the API", async () => {
    const calls = stub();
    renderWith(<AdminMemberLedger />);
    await screen.findByRole("heading", { name: "Bo Berg" });
    fireEvent.click(screen.getByRole("button", { name: /record payment/i }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: /save payment/i }));
    expect(await screen.findByText(/whole kronor/i)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("waives a charge with a required reason", async () => {
    const calls = stub(() => json(201, { entryId: "led_w", balanceSek: 120 }));
    renderWith(<AdminMemberLedger />);
    await screen.findByRole("heading", { name: "Bo Berg" });

    const [firstWaive] = screen.getAllByRole("button", { name: /waive/i });
    if (!firstWaive) throw new Error("no waive button");
    fireEvent.click(firstWaive);
    fireEvent.click(screen.getByRole("button", { name: /confirm waiver/i }));
    expect(await screen.findByText(/reason is required/i)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Injured" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm waiver/i }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });
    expect(calls.find((c) => c.method === "POST")).toMatchObject({
      path: "/admin/adjustments",
      body: { type: "waiver", entryId: "led_c1", note: "Injured" },
    });
  });

  it("explains the self-ledger guard in plain words", async () => {
    stub(() => json(403, { error: "self_ledger_blocked" }));
    renderWith(<AdminMemberLedger />);
    await screen.findByRole("heading", { name: "Bo Berg" });
    fireEvent.click(screen.getByRole("button", { name: /record payment/i }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /save payment/i }));
    expect(await screen.findByText(/another admin must record it/i)).toBeTruthy();
  });

  it("uses a fresh Idempotency-Key after a definite refusal, so the corrected retry is not a replay", async () => {
    let attempts = 0;
    const calls = stub(() => {
      attempts += 1;
      return attempts === 1
        ? json(404, { error: "member_not_found" })
        : json(201, { entryId: "led_p", balanceSek: 0 });
    });
    renderWith(<AdminMemberLedger />);
    await screen.findByRole("heading", { name: "Bo Berg" });
    fireEvent.click(screen.getByRole("button", { name: /record payment/i }));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /save payment/i }));
    expect(await screen.findByText(/no longer exists/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /save payment/i }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    });
    const [first, second] = calls.filter((c) => c.method === "POST");
    expect(second?.key).toBeTruthy();
    expect(second?.key).not.toBe(first?.key);
  });

  it("assigns a pass from the member ledger, showing returning rate, disabling owned/sold-out, and reloading", async () => {
    const ownedOffer = { ...offerRegular, alreadyOwned: true };
    const soldOutOffer = {
      ...offerRegular,
      seriesId: "ser_wed",
      seriesName: "Wednesday Open",
      seatsRemaining: 0,
    };
    const calls = stub(() => json(201, { pass: { id: "pas_2" }, upgradedRsvps: 1 }), {
      m2: [ownedOffer, soldOutOffer, offerDiscounted],
    });
    renderWith(<AdminMemberLedger />);
    await screen.findByRole("heading", { name: "Bo Berg" });

    fireEvent.click(screen.getByRole("button", { name: /assign pass/i }));
    const dialog = screen.getByRole("dialog", { name: /assign pass to Bo Berg/i });

    await within(dialog).findByText(/Tuesday MD · Spring 2027/);
    expect(within(dialog).getByText(/1000 kr \(returning rate\)/)).toBeTruthy();
    expect(within(dialog).getByText(/8 of 10 sessions · 3 of 10 seats left/)).toBeTruthy();
    expect(within(dialog).getByText("Already holds pass")).toBeTruthy();
    expect(within(dialog).getByText("Sold out")).toBeTruthy();
    expect(within(dialog).queryByLabelText(/price|amount/i)).toBeNull();

    const radios = within(dialog).getAllByRole<HTMLInputElement>("radio");
    expect(radios[0]?.disabled).toBe(true);
    expect(radios[1]?.disabled).toBe(true);
    expect(radios[2]?.disabled).toBe(false);
    expect(radios[2]?.checked).toBe(true);

    fireEvent.click(within(dialog).getByRole("button", { name: /assign pass \(1000 kr\)/i }));

    await waitFor(() => {
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });
    const post = calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({
      path: "/admin/passes",
      body: { memberId: "m2", seriesId: "ser_tue" },
    });
    expect(post?.key).toBeTruthy();
    expect(await screen.findByText("Assigned pass to Bo Berg.")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(calls.filter((c) => c.method === "GET" && c.path === "/admin/balances/m2")).toHaveLength(
      2,
    );
  });

  it("shows empty state when no pass offers are open and handles already_has_pass errors", async () => {
    const emptyCalls = stub(() => json(201, {}), { m2: [] });
    renderWith(<AdminMemberLedger />);
    await screen.findByRole("heading", { name: "Bo Berg" });

    fireEvent.click(screen.getByRole("button", { name: /assign pass/i }));
    const emptyDialog = screen.getByRole("dialog", { name: /assign pass to Bo Berg/i });
    await within(emptyDialog).findByText("No passes available");
    expect(
      within(emptyDialog).getByRole<HTMLButtonElement>("button", {
        name: /^assign pass$/i,
      }).disabled,
    ).toBe(true);
    expect(emptyCalls.filter((c) => c.method === "POST")).toHaveLength(0);

    cleanup();
    const revokeCalls: Call[] = [];
    configureApiClient({
      fetch: vi.fn((input: string, init?: RequestInit) => {
        const path = input.replace("/api/v1", "");
        const method = init?.method ?? "GET";
        const body: unknown = init?.body ? JSON.parse(init.body as string) : null;
        const headers = new Headers(init?.headers);
        revokeCalls.push({ method, path, body, key: headers.get("Idempotency-Key") });
        if (method === "GET" && path === "/admin/balances/m2") {
          return Promise.resolve(
            json(200, {
              member: { id: "m2", displayName: "Bo Berg", paymentRef: "BC-BO", status: "active" },
              balanceSek: 900,
              owedSek: 900,
              creditSek: 0,
              items: [
                {
                  id: "led_pas",
                  kind: "charge",
                  reason: "pass",
                  amountSek: 900,
                  status: "unpaid",
                  allocatedSek: 0,
                  outstandingSek: 900,
                  note: "Monday MD — Spring 2027",
                  createdAt: "2027-01-01T10:00:00.000Z",
                  reversesEntryId: null,
                  eventTitle: null,
                  eventStartsAt: null,
                  passId: "pas_1",
                  passRevocable: true,
                  waivable: true,
                  reversible: false,
                },
              ],
            }),
          );
        }
        return Promise.resolve(json(200, { pass: { id: "pas_1", status: "revoked" } }));
      }),
    });
    renderWith(<AdminMemberLedger />);
    await screen.findByRole("heading", { name: "Bo Berg" });
    expect(screen.queryByRole("button", { name: /reverse/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /revoke pass/i }));
    const revokeConfirm = await screen.findByRole("dialog", { name: "Revoke Pass?" });
    fireEvent.click(within(revokeConfirm).getByRole("button", { name: "Confirm Revocation" }));
    await waitFor(() => {
      expect(
        revokeCalls.some((c) => c.method === "POST" && c.path === "/admin/passes/pas_1/revoke"),
      ).toBe(true);
    });
    expect(await screen.findByText("Revoked Bo Berg's pass.")).toBeTruthy();

    cleanup();
    let attempts = 0;
    const errorCalls = stub(() => {
      attempts += 1;
      return attempts === 1
        ? json(409, { error: "already_has_pass" })
        : json(201, { pass: { id: "pas_3" }, upgradedRsvps: 0 });
    });
    renderWith(<AdminMemberLedger />);
    await screen.findByRole("heading", { name: "Bo Berg" });

    fireEvent.click(screen.getByRole("button", { name: /assign pass/i }));
    const dialog = screen.getByRole("dialog", { name: /assign pass to Bo Berg/i });
    await within(dialog).findByText(/Tuesday MD · Spring 2027/);

    fireEvent.click(within(dialog).getByRole("button", { name: /assign pass \(1000 kr\)/i }));
    expect(
      await within(dialog).findByText(/already holds an active pass for that series/i),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: /assign pass \(1000 kr\)/i }));
    await waitFor(() => {
      expect(errorCalls.filter((c) => c.method === "POST")).toHaveLength(2);
    });
    const [first, second] = errorCalls.filter((c) => c.method === "POST");
    expect(first?.key).toBeTruthy();
    expect(second?.key).toBeTruthy();
    expect(second?.key).not.toBe(first?.key);
  });

  it("surfaces Unpaid entries above Ledger History, formats Club Fee and dates, copies ref, and confirms Reverse", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    configureApiClient({
      fetch: vi.fn((input: string) => {
        const path = input.replace("/api/v1", "");
        if (path === "/admin/balances/m2") {
          return Promise.resolve(
            json(200, {
              member: { id: "m2", displayName: "Bo Berg", paymentRef: "BC-BO", status: "active" },
              balanceSek: 85,
              owedSek: 85,
              creditSek: 0,
              items: [
                {
                  id: "led_rev_orig",
                  kind: "charge",
                  reason: "club_fee",
                  amountSek: 160,
                  status: "reversed",
                  allocatedSek: 0,
                  outstandingSek: 0,
                  note: "Club fee — Fall 2026/2027",
                  createdAt: "2026-11-28T10:00:00.000Z",
                  reversesEntryId: null,
                  eventTitle: null,
                  eventStartsAt: null,
                  waivable: false,
                  reversible: false,
                },
                {
                  id: "led_rev_adj",
                  kind: "reversal",
                  reason: "club_fee",
                  amountSek: -160,
                  status: "reversal",
                  allocatedSek: 0,
                  outstandingSek: 0,
                  note: "Test",
                  createdAt: "2026-11-28T10:05:00.000Z",
                  reversesEntryId: "led_rev_orig",
                  eventTitle: null,
                  eventStartsAt: null,
                  waivable: false,
                  reversible: false,
                },
                {
                  id: "led_unpaid_fee",
                  kind: "charge",
                  reason: "club_fee",
                  amountSek: 85,
                  status: "unpaid",
                  allocatedSek: 0,
                  outstandingSek: 85,
                  note: "Club fee — Spring 2026/2027",
                  createdAt: "2026-11-28T11:00:00.000Z",
                  reversesEntryId: null,
                  eventTitle: null,
                  eventStartsAt: null,
                  waivable: true,
                  reversible: true,
                },
              ],
            }),
          );
        }
        return Promise.resolve(json(404, { error: "not_found" }));
      }),
    });

    renderWith(<AdminMemberLedger />);
    await screen.findByRole("heading", { name: "Bo Berg" });

    const unpaidHeading = screen.getByRole("heading", { name: "Unpaid (1)" });
    const historyHeading = screen.getByRole("heading", { name: "Ledger History (2)" });
    expect(
      unpaidHeading.compareDocumentPosition(historyHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(screen.getByText("Club Fee · 85 kr")).toBeTruthy();
    const reversalHeading = screen.getByText("Club Fee · -160 kr");
    const reversedHeading = screen.getByText("Club Fee · 160 kr");
    expect(
      reversalHeading.compareDocumentPosition(reversedHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("28 Nov 2026 · 85 kr left · Spring 2026/2027")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy payment reference BC-BO" }));
    expect(writeText).toHaveBeenCalledWith("BC-BO");
    expect(await screen.findByText("Copied")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reverse Club Fee · 85 kr" }));
    const reverseSheet = await screen.findByRole("dialog", { name: "Reverse Club Fee · 85 kr" });
    expect(
      within(reverseSheet).getByText("Reverse Club Fee · 85 kr — Spring 2026/2027 for Bo Berg?"),
    ).toBeTruthy();
    fireEvent.click(within(reverseSheet).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("club fees page", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/admin/money/club-fees");
  });

  it("filters Paid in Fall members and displays parallel filter counts", async () => {
    stub();
    renderWith(<AdminClubFees />);
    const list = await screen.findByRole("list", { name: /club fee members/i });
    expect(screen.getByRole("heading", { name: "Club Fees" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /All \(/ }).getAttribute("checked")).not.toBeNull();
    expect(screen.getByRole("radio", { name: /Paid in Spring \(/ })).toBeTruthy();
    expect(within(list).getByText("Ada Fall")).toBeTruthy();
    expect(within(list).getByText("Bo External")).toBeTruthy();
    expect(within(list).getByText("Cy Spring")).toBeTruthy();
    expect(within(list).getByText("Di Uncharged")).toBeTruthy();
    expect(within(list).getByText("Paid Externally")).toBeTruthy();
    expect(within(list).getByText("Not Charged")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /Paid in Fall/ }));
    expect(within(list).getByText("Ada Fall")).toBeTruthy();
    expect(within(list).getByText("Bo External")).toBeTruthy();
    expect(within(list).queryByText("Cy Spring")).toBeNull();
    expect(within(list).queryByText("Di Uncharged")).toBeNull();
  });

  it("shows single Charge Fall button + overflow sheet without duplicate Charge Fall", async () => {
    stub();
    renderWith(<AdminClubFees />);
    const list = await screen.findByRole("list", { name: /club fee members/i });
    expect(within(list).getByRole("button", { name: "Charge Fall (160 kr)" })).toBeTruthy();
    expect(within(list).queryByRole("button", { name: "Mark Fall Paid" })).toBeNull();

    fireEvent.click(within(list).getByRole("button", { name: "More actions for Di Uncharged" }));
    const sheet = await screen.findByRole("dialog", { name: "Member Club Fee Actions" });
    expect(within(sheet).queryByRole("button", { name: /Charge Fall/ })).toBeNull();
    expect(within(sheet).getByRole("button", { name: "Charge Spring (85 kr)" })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Mark Fall Paid" })).toBeTruthy();
  });

  it("confirms bulk Spring charge via Select Not Charged -> Bulk Actions and marks selected paid externally", async () => {
    const calls = stub((path) => {
      if (path === "/admin/club-fees/charge") {
        return json(200, { chargedCount: 1, skippedCount: 3, chargedMemberIds: ["m4"] });
      }
      if (path === "/admin/club-fees/mark-external-fall") {
        return json(200, { markedCount: 1, skippedCount: 0 });
      }
      return json(200, {});
    });
    renderWith(<AdminClubFees />);
    await screen.findByRole("list", { name: /club fee members/i });
    expect(screen.queryByRole("button", { name: "Charge All" })).toBeNull();

    // Select not charged -> selects Di Uncharged (m4), then open Bulk Actions -> Mark Paid Externally.
    fireEvent.click(screen.getByRole("button", { name: /Select Not Charged/ }));
    fireEvent.click(screen.getByRole("button", { name: "Bulk Actions" }));
    const bulkSheet = await screen.findByRole("dialog", { name: /Selected \(1 Member\)/ });
    fireEvent.click(
      within(bulkSheet).getByRole("button", { name: "Mark Paid in Fall (Outside App)" }),
    );

    await waitFor(() => {
      expect(calls.some((c) => c.path === "/admin/club-fees/mark-external-fall")).toBe(true);
    });
    expect(calls.find((c) => c.path === "/admin/club-fees/mark-external-fall")).toMatchObject({
      method: "POST",
      body: { clubYear: 2026, memberIds: ["m4"] },
    });

    // Clear selection happened on reload; select Di Uncharged again -> Bulk Actions -> Charge Spring -> ConfirmDialog.
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Selected actions" })).toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: /Select Not Charged/ }));
    fireEvent.click(screen.getByRole("button", { name: "Bulk Actions" }));
    const bulkSheet2 = await screen.findByRole("dialog", { name: /Selected \(1 Member\)/ });
    fireEvent.click(within(bulkSheet2).getByRole("button", { name: "Charge Spring (85 kr)" }));
    const confirm = await screen.findByRole("dialog", {
      name: /Charge Spring Fee \(85 kr\) to 1 Selected Member\?/,
    });
    expect(within(confirm).getByText(/skipped automatically/i)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm & Charge (85 kr)" }));

    await waitFor(() => {
      expect(calls.some((c) => c.path === "/admin/club-fees/charge")).toBe(true);
    });
    expect(calls.find((c) => c.path === "/admin/club-fees/charge")).toMatchObject({
      method: "POST",
      body: { clubYear: 2026, season: "spring", memberIds: ["m4"] },
    });
  });

  it("confirms before clearing external mark via overflow menu", async () => {
    const calls = stub(() => json(200, {}));
    renderWith(<AdminClubFees />);
    const list = await screen.findByRole("list", { name: /club fee members/i });
    fireEvent.click(within(list).getByRole("button", { name: "More actions for Bo External" }));
    const sheet = await screen.findByRole("dialog", { name: "Member Club Fee Actions" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Clear External Mark" }));
    const confirm = await screen.findByRole("dialog", { name: "Clear External Mark?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Clear Mark" }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/clear"))).toBe(true);
    });
  });
});
