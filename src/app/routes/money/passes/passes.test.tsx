import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../api/client";
import { ToastProvider } from "../../../components/ui/Toast";
import { FeatureFlagsProvider } from "../../../lib/flags";
import { AdminBalances } from "../../admin/money/AdminBalances";
import { registeredFrontendRoutes } from "../../registry";
import { PassesPage } from "./PassesPage";

const offer1 = {
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
};

const ownedPass = {
  id: "pas_owned",
  seriesId: "ser_2",
  seriesName: "Sunday Mixed",
  termName: "Spring 2027",
  priceCharged: 1200,
  eventsCovered: 10,
  status: "active" as const,
  purchasedAt: "2027-01-10T10:00:00.000Z",
  revokedAt: null,
};

const revocableAdminPass = {
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
  chargeStatus: "unpaid" as const,
  unpaidSek: 1800,
  daysElapsed: 25,
  revocable: true,
};

const balanceMembers = [
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
];

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

function stubApi(
  postHandler: (path: string, body: unknown) => Response = () => json(201, {}),
  opts: { passesPayload?: unknown } = {},
) {
  const calls: Call[] = [];
  configureApiClient({
    fetch: vi.fn((input: string, init?: RequestInit) => {
      const path = input.replace("/api/v1", "");
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const key = new Headers(init?.headers).get("Idempotency-Key");
      calls.push({ method, path, body, key });
      if (method === "GET" && path === "/passes/offers") {
        return Promise.resolve(
          json(200, opts.passesPayload ?? { offers: [offer1], passes: [ownedPass] }),
        );
      }
      if (method === "GET" && path === "/admin/balances") {
        return Promise.resolve(json(200, { members: balanceMembers }));
      }
      if (method === "GET" && path === "/admin/passes") {
        return Promise.resolve(json(200, { passes: [revocableAdminPass] }));
      }
      return Promise.resolve(postHandler(path, body));
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

afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("passes routes", () => {
  it("registers the passes screen", () => {
    const paths = registeredFrontendRoutes().map((r) => r.path);
    expect(paths).toContain("/money/passes");
  });
});

describe("member passes page", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/money/passes");
  });

  it("is hidden while the money flag is off", () => {
    stubApi();
    renderWith(<PassesPage />, false);
    expect(screen.getByText(/not switched on yet/i)).toBeTruthy();
  });

  it("shows prorated offers and the terms notice before purchase, and has no refund action", async () => {
    stubApi();
    renderWith(<PassesPage />);
    expect(await screen.findByText("Thursday XD")).toBeTruthy();
    expect(screen.getByText(/900 kr/)).toBeTruthy();
    expect(
      screen.getByText("Covers up to 6 sessions; no refunds; cancelled nights not compensated."),
    ).toBeTruthy();
    expect(screen.getByText("Sunday Mixed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /refund|cancel pass/i })).toBeNull();
  });

  it("confirms purchase with terms notice and sends Idempotency-Key, reusing key on 409 in-progress", async () => {
    let attempts = 0;
    const calls = stubApi(() => {
      attempts += 1;
      return attempts === 1
        ? json(409, { error: "idempotency_key_in_progress" })
        : json(201, { pass: { ...ownedPass, id: "pas_new" }, upgradedRsvps: 1 });
    });
    renderWith(<PassesPage />);

    const buyBtn = await screen.findByRole("button", { name: /buy pass/i });
    fireEvent.click(buyBtn);

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "Covers up to 6 sessions; no refunds; cancelled nights not compensated.",
      ),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: /confirm purchase/i }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });

    fireEvent.click(within(dialog).getByRole("button", { name: /confirm purchase/i }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    });

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts[0]).toMatchObject({ path: "/passes", body: { seriesId: "ser_1" } });
    expect(posts[0]?.key).toBeTruthy();
    expect(posts[1]?.key).toBe(posts[0]?.key);
  });
});

describe("admin balances revocable filter and pass revocation", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/admin/money");
  });

  it("filters to revocable passes and revokes with Idempotency-Key", async () => {
    const calls = stubApi(() =>
      json(200, {
        pass: { id: "pas_rev", status: "revoked", revokedAt: "2027-01-26T10:00:00.000Z" },
        reversalEntryId: "led_r1",
        downgradedRsvps: 1,
      }),
    );
    renderWith(<AdminBalances />);

    await screen.findByText("Bo Berg");
    fireEvent.click(screen.getByRole("radio", { name: /revocable/i }));

    const list = screen.getByRole("list", { name: /balances/i });
    expect(within(list).getByText("Bo Berg")).toBeTruthy();
    expect(within(list).queryByText("Cy Dahl")).toBeNull();

    fireEvent.click(within(list).getByRole("button", { name: /revoke pass/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /confirm revocation/i }));

    await waitFor(() => {
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/admin/passes/pas_rev/revoke");
    expect(post?.key).toBeTruthy();
  });

  it("shows a returning member rate badge on discounted pass offers", async () => {
    stubApi(undefined, {
      passesPayload: {
        offers: [
          { ...offer1, passPrice: 700, regularPassPrice: 1000, discounted: true, priceSek: 700 },
        ],
        passes: [],
      },
    });
    renderWith(<PassesPage />);
    expect(await screen.findByText("Returning Member Rate")).toBeTruthy();
    expect(screen.getByText("700 kr")).toBeTruthy();
  });
});
