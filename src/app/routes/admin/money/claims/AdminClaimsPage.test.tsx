import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../../api/client";
import { ToastProvider } from "../../../../components/ui/Toast";
import { FeatureFlagsProvider } from "../../../../lib/flags";
import { registeredFrontendRoutes } from "../../../registry";

interface AdminClaimDto {
  id: string;
  memberId: string;
  amountSek: number;
  paidOn: string;
  note: string | null;
  status: "pending" | "confirmed" | "rejected";
  decidedAt: string | null;
  rejectReason: string | null;
  displayName: string;
  paymentRef: string;
  balanceSek: number;
  isOwn: boolean;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
  key: string | null;
}

const boClaim: AdminClaimDto = {
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
};

const ownClaim: AdminClaimDto = {
  id: "clm_own",
  memberId: "mem_ada",
  amountSek: 120,
  paidOn: "2027-02-22",
  note: null,
  status: "pending",
  decidedAt: null,
  rejectReason: null,
  displayName: "Ada Admin",
  paymentRef: "BOLT-ADA",
  balanceSek: 120,
  isOwn: true,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubAdminClaimsApi(
  claims: AdminClaimDto[] = [boClaim, ownClaim],
  post: (path: string, body: unknown, key: string | null) => Response = (path) =>
    path.endsWith("/confirm")
      ? json(200, { claimId: "clm_bo", status: "confirmed", entryId: "led_claim:clm_bo" })
      : json(200, { claimId: "clm_bo", status: "rejected" }),
) {
  const calls: Call[] = [];
  configureApiClient({
    fetch: vi.fn((input: string, init?: RequestInit) => {
      const path = input.replace("/api/v1", "");
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const key = new Headers(init?.headers).get("Idempotency-Key");
      calls.push({ method, path, body, key });
      if (method === "GET" && path === "/admin/payment-claims") {
        return Promise.resolve(json(200, { claims }));
      }
      if (method === "POST") {
        return Promise.resolve(post(path, body, key));
      }
      return Promise.resolve(json(500, { error: "unexpected" }));
    }),
    onUnauthorized: () => undefined,
  });
  return calls;
}

function renderAdminClaims(money = true) {
  const route = registeredFrontendRoutes().find((r) => r.path === "/admin/money/claims");
  expect(route).toBeDefined();
  const Component = route!.component;
  render(
    <FeatureFlagsProvider flags={{ money }}>
      <ToastProvider>
        <Component />
      </ToastProvider>
    </FeatureFlagsProvider>,
  );
}

describe("admin payment claims queue", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/admin/money/claims");
  });

  afterEach(() => {
    cleanup();
    configureApiClient({});
  });

  it("is gated on the money feature flag", () => {
    stubAdminClaimsApi();
    renderAdminClaims(false);
    expect(screen.getByText(/not switched on yet/i)).toBeTruthy();
  });

  it("shows pending claims with balance, payment reference, and disables/explains own claims", async () => {
    stubAdminClaimsApi();
    renderAdminClaims();

    const list = await screen.findByRole("list", { name: /pending payment claims/i });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);

    const boRow = rows[0]!;
    expect(within(boRow).getByText("Bo Berg")).toBeTruthy();
    expect(within(boRow).getByText("240 kr")).toBeTruthy();
    expect(within(boRow).getByText(/Owes 240 kr/)).toBeTruthy();
    expect(within(boRow).getByText(/BOLT-BO/)).toBeTruthy();
    expect(within(boRow).getByText(/Swish/)).toBeTruthy();

    const ownRow = rows[1]!;
    expect(within(ownRow).getByText("Ada Admin")).toBeTruthy();
    expect(within(ownRow).getByText(/Your claim/i)).toBeTruthy();
    expect(within(ownRow).getByText(/another admin/i)).toBeTruthy();
    expect(
      within(ownRow).getByRole("button", { name: /confirm/i }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(ownRow).getByRole("button", { name: /reject/i }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("one-tap confirm sends POST with Idempotency-Key and reuses it on retry", async () => {
    let attempts = 0;
    const calls = stubAdminClaimsApi([boClaim], () => {
      attempts += 1;
      return attempts === 1
        ? json(409, { error: "idempotency_key_in_progress" })
        : json(200, { claimId: "clm_bo", status: "confirmed", entryId: "led_claim:clm_bo" });
    });

    renderAdminClaims();
    await screen.findByText("Bo Berg");

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts[0]?.path).toBe("/admin/payment-claims/clm_bo/confirm");
    expect(posts[0]?.key).toBeTruthy();
    expect(posts[1]?.key).toBe(posts[0]?.key);
    expect(await screen.findByText(/payment confirmed/i)).toBeTruthy();
  });

  it("reject requires a non-blank reason and sends POST with Idempotency-Key", async () => {
    const calls = stubAdminClaimsApi([boClaim]);
    renderAdminClaims();
    await screen.findByText("Bo Berg");

    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /reject claim/i }));
    expect(await screen.findByText(/reason is required/i)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: "No transfer with your reference" },
    });
    fireEvent.click(screen.getByRole("button", { name: /reject claim/i }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));

    const post = calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({
      path: "/admin/payment-claims/clm_bo/reject",
      body: { reason: "No transfer with your reference" },
    });
    expect(post?.key).toBeTruthy();
    expect(await screen.findByText(/claim rejected/i)).toBeTruthy();
  });

  it("explains 403 own_claim if returned by the server", async () => {
    const misflagged: AdminClaimDto = { ...ownClaim, isOwn: false };
    stubAdminClaimsApi([misflagged], () => json(403, { error: "own_claim" }));

    renderAdminClaims();
    await screen.findByText("Ada Admin");

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(await screen.findByText(/own payment claim/i)).toBeTruthy();
  });
});
