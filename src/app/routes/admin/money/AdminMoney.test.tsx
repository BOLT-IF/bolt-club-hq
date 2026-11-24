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

function stub(post: (path: string, body: unknown) => Response = () => json(201, {})) {
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
      if (method === "GET" && path === "/admin/balances/m2") return Promise.resolve(json(200, detail));
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
});
