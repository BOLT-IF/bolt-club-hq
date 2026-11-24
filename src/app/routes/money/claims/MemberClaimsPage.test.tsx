import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../api/client";
import { ToastProvider } from "../../../components/ui/Toast";
import { FeatureFlagsProvider } from "../../../lib/flags";
import { registeredFrontendRoutes } from "../../registry";

interface ClaimDto {
  id: string;
  memberId: string;
  amountSek: number;
  paidOn: string;
  note: string | null;
  status: "pending" | "confirmed" | "rejected";
  decidedAt: string | null;
  rejectReason: string | null;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
  key: string | null;
}

const sampleClaims: ClaimDto[] = [
  {
    id: "clm_1",
    memberId: "mem_1",
    amountSek: 240,
    paidOn: "2027-02-20",
    note: "Swish",
    status: "pending",
    decidedAt: null,
    rejectReason: null,
  },
  {
    id: "clm_2",
    memberId: "mem_1",
    amountSek: 120,
    paidOn: "2027-02-10",
    note: null,
    status: "rejected",
    decidedAt: "2027-02-11T12:00:00.000Z",
    rejectReason: "No transfer found with your reference",
  },
  {
    id: "clm_3",
    memberId: "mem_1",
    amountSek: 500,
    paidOn: "2027-01-15",
    note: "Spring pass",
    status: "confirmed",
    decidedAt: "2027-01-16T09:00:00.000Z",
    rejectReason: null,
  },
];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubClaimsApi(
  claims: ClaimDto[] = sampleClaims,
  post: (body: unknown, key: string | null) => Response = () =>
    json(201, {
      id: "clm_new",
      memberId: "mem_1",
      amountSek: 300,
      paidOn: "2027-02-25",
      note: "Bankgiro",
      status: "pending",
      decidedAt: null,
      rejectReason: null,
    }),
) {
  const calls: Call[] = [];
  configureApiClient({
    fetch: vi.fn((input: string, init?: RequestInit) => {
      const path = input.replace("/api/v1", "");
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const key = new Headers(init?.headers).get("Idempotency-Key");
      calls.push({ method, path, body, key });
      if (method === "GET" && path === "/me/payment-claims") {
        return Promise.resolve(json(200, { claims }));
      }
      if (method === "POST" && path === "/me/payment-claims") {
        return Promise.resolve(post(body, key));
      }
      return Promise.resolve(json(500, { error: "unexpected" }));
    }),
    onUnauthorized: () => undefined,
  });
  return calls;
}

function renderMemberClaims(money = true) {
  const route = registeredFrontendRoutes().find((r) => r.path === "/money/claims");
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

describe("member payment claims screen", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2027-02-25T10:00:00Z"));
    window.history.pushState({}, "", "/money/claims");
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    configureApiClient({});
  });

  it("is gated on the money feature flag", () => {
    stubClaimsApi();
    renderMemberClaims(false);
    expect(screen.getByText(/not switched on yet/i)).toBeTruthy();
  });

  it("lists the member's claims with status chips and rejection reason", async () => {
    stubClaimsApi();
    renderMemberClaims();

    const list = await screen.findByRole("list", { name: /payment claims/i });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    expect(within(rows[0]!).getByText("240 kr")).toBeTruthy();
    expect(within(rows[0]!).getByText("Pending")).toBeTruthy();
    expect(within(rows[0]!).getByText(/Swish/)).toBeTruthy();

    expect(within(rows[1]!).getByText("120 kr")).toBeTruthy();
    expect(within(rows[1]!).getByText("Rejected")).toBeTruthy();
    expect(within(rows[1]!).getByText(/No transfer found with your reference/)).toBeTruthy();

    expect(within(rows[2]!).getByText("500 kr")).toBeTruthy();
    expect(within(rows[2]!).getByText("Confirmed")).toBeTruthy();
  });

  it("submits an I've paid claim with Idempotency-Key, whole kronor > 0, paidOn and optional note", async () => {
    const calls = stubClaimsApi([]);
    renderMemberClaims();
    await screen.findByText(/no payment claims yet/i);

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "300" } });
    fireEvent.change(screen.getByLabelText(/date paid/i), { target: { value: "2027-02-24" } });
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "Bankgiro" } });
    fireEvent.click(screen.getByRole("button", { name: /submit claim/i }));

    await waitFor(() => {
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });
    const post = calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({
      path: "/me/payment-claims",
      body: { amountSek: 300, paidOn: "2027-02-24", note: "Bankgiro" },
    });
    expect(post?.key).toBeTruthy();
    expect(await screen.findByText(/claim submitted/i)).toBeTruthy();
  });

  it("validates whole kronor > 0 and paidOn not after today before calling the API", async () => {
    const calls = stubClaimsApi([]);
    renderMemberClaims();
    await screen.findByText(/no payment claims yet/i);

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: /submit claim/i }));
    expect(await screen.findByText(/whole kronor/i)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText(/date paid/i), { target: { value: "2027-02-26" } });
    fireEvent.click(screen.getByRole("button", { name: /submit claim/i }));
    expect(await screen.findByText(/in the future/i)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("reuses the Idempotency-Key on a retry after idempotency_key_in_progress, and rotates after a final 4xx", async () => {
    let attempts = 0;
    const calls = stubClaimsApi([], () => {
      attempts += 1;
      if (attempts === 1) return json(409, { error: "idempotency_key_in_progress" });
      if (attempts === 2) return json(400, { error: "invalid_paid_on" });
      return json(201, {
        id: "clm_new",
        memberId: "mem_1",
        amountSek: 200,
        paidOn: "2027-02-25",
        note: null,
        status: "pending",
        decidedAt: null,
        rejectReason: null,
      });
    });

    renderMemberClaims();
    await screen.findByText(/no payment claims yet/i);

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: /submit claim/i }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });

    // Retry after 409 in progress -> same key
    fireEvent.click(screen.getByRole("button", { name: /submit claim/i }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    });

    // Retry after final 400 -> new key
    fireEvent.click(screen.getByRole("button", { name: /submit claim/i }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(3);
    });

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts[0]?.key).toBeTruthy();
    expect(posts[1]?.key).toBe(posts[0]?.key);
    expect(posts[2]?.key).toBeTruthy();
    expect(posts[2]?.key).not.toBe(posts[0]?.key);
  });
});
