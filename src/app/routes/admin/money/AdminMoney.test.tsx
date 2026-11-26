import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../api/client";
import { ToastProvider } from "../../../components/ui/Toast";
import { FeatureFlagsProvider } from "../../../lib/flags";
import { registeredFrontendRoutes } from "../../registry";
import { AdminBalances } from "./AdminBalances";
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
  format: "XD",
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
        return Promise.resolve(json(200, { revokeAfterDays: 21, passes: [] }));
      if (method === "GET" && path === "/admin/balances/m2")
        return Promise.resolve(json(200, detail));
      if (method === "GET" && path.startsWith("/admin/passes/offers")) {
        const url = new URL(path, "http://localhost");
        const memberId = url.searchParams.get("memberId") ?? "";
        return Promise.resolve(json(200, { offers: offersByMember[memberId] ?? [] }));
      }
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
  it("registers the balances and member ledger pages", () => {
    const paths = registeredFrontendRoutes().map((r) => r.path);
    expect(paths).toContain("/admin/money");
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
    expect(screen.getByRole("link", { name: "Payment claims" }).getAttribute("href")).toBe(
      "/admin/money/claims",
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
    const disabledSubmit = within(emptyDialog).getByRole<HTMLButtonElement>("button", {
      name: /^assign pass$/i,
    });
    expect(disabledSubmit.disabled).toBe(true);
    expect(emptyCalls.filter((c) => c.method === "POST")).toHaveLength(0);

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
});
