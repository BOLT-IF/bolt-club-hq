import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../api/client";
import type { LedgerItem, MyLedger } from "../../api/ledger";
import { ToastProvider } from "../../components/ui";
import { registeredFrontendRoutes } from "../registry";

const item = (over: Partial<LedgerItem> & { id: string }): LedgerItem => ({
  kind: "charge",
  reason: "adhoc",
  amountSek: 120,
  status: "unpaid",
  allocatedSek: 0,
  outstandingSek: 120,
  note: null,
  createdAt: "2027-01-14T20:00:00.000Z",
  reversesEntryId: null,
  passId: null,
  eventId: "ev1",
  eventTitle: "Thursday XD",
  eventStartsAt: "2027-01-14T18:00:00.000Z",
  guestId: null,
  guestName: null,
  ...over,
});

const owing: MyLedger = {
  balanceSek: 90,
  owedSek: 90,
  creditSek: 0,
  items: [
    item({ id: "c1", status: "paid", allocatedSek: 120, outstandingSek: 0 }),
    item({
      id: "c2",
      reason: "guest",
      status: "partly_paid",
      allocatedSek: 30,
      outstandingSek: 90,
      guestId: "g1",
      guestName: "Sam Guest",
      createdAt: "2027-01-14T20:00:01.000Z",
    }),
    item({
      id: "p1",
      kind: "payment",
      reason: "payment",
      amountSek: -150,
      status: "applied",
      allocatedSek: 150,
      outstandingSek: 0,
      eventId: null,
      eventTitle: null,
      eventStartsAt: null,
      createdAt: "2027-01-15T09:00:00.000Z",
    }),
  ],
};

const settings = {
  clubName: "Bolt Club",
  bank: { accountHolder: "Bolt IF", iban: "SE4550000000058398257466", bankgiro: "5050-1055" },
  paymentInstructions: "Pay within 14 days.",
  quietHours: null,
  rosterAppUrl: null,
};

const profile = {
  id: "mem_1",
  displayName: "Alex",
  rosterName: null,
  email: "a@x",
  paymentRef: "BOLT-ALEX",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubApi(
  ledger: MyLedger | number,
  opts: { settings?: unknown; profile?: unknown } = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string) => {
    if (input === "/api/v1/me/ledger") {
      return Promise.resolve(
        typeof ledger === "number" ? json({ error: "x" }, ledger) : json(ledger),
      );
    }
    if (input === "/api/v1/settings/public") {
      return Promise.resolve(
        opts.settings === undefined ? json(settings) : json(opts.settings, 403),
      );
    }
    if (input === "/api/v1/me/profile") {
      return Promise.resolve(opts.profile === undefined ? json(profile) : json({}, 403));
    }
    return Promise.resolve(json({ error: "unexpected" }, 500));
  });
  configureApiClient({ fetch: fetchMock, onUnauthorized: () => undefined });
  return fetchMock;
}

function renderMoney() {
  const route = registeredFrontendRoutes().find((r) => r.path === "/money");
  expect(route).toBeDefined();
  const Component = route!.component;
  render(
    <ToastProvider>
      <Component />
    </ToastProvider>,
  );
}

describe("member money screen", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/money");
  });
  afterEach(() => {
    cleanup();
    configureApiClient({});
  });

  it("asks only for the caller's own ledger (no member id is ever sent)", async () => {
    const fetchMock = stubApi(owing);
    renderMoney();
    await screen.findByText("You owe 90 kr");
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls).toContain("/api/v1/me/ledger");
    expect(urls.some((u) => u.includes("memberId"))).toBe(false);
  });

  it("shows the balance and every item with its event date, guest name and FIFO status", async () => {
    stubApi(owing);
    renderMoney();
    expect(await screen.findByText("You owe 90 kr")).toBeTruthy();

    const list = screen.getByRole("list", { name: "Ledger entries" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    // Newest first.
    expect(within(rows[0]!).getByText("Payment")).toBeTruthy();
    expect(within(rows[0]!).getByText("−150 kr")).toBeTruthy();

    const guestRow = rows[1]!;
    expect(within(guestRow).getByText("Guest fee")).toBeTruthy();
    expect(within(guestRow).getByText(/Sam Guest/)).toBeTruthy();
    expect(within(guestRow).getByText(/Thursday XD/)).toBeTruthy();
    expect(within(guestRow).getByText(/Thu 14 Jan/)).toBeTruthy();
    expect(within(guestRow).getByText("Partly paid, 90 kr left")).toBeTruthy();

    expect(within(rows[2]!).getByText("Paid")).toBeTruthy();
  });

  it("displays credit as credit, not as a negative debt", async () => {
    stubApi({
      balanceSek: -100,
      owedSek: 0,
      creditSek: 100,
      items: [
        item({
          id: "p1",
          kind: "payment",
          reason: "payment",
          amountSek: -100,
          status: "unapplied",
          allocatedSek: 0,
          outstandingSek: 100,
          eventId: null,
          eventTitle: null,
          eventStartsAt: null,
        }),
      ],
    });
    renderMoney();
    expect(await screen.findByText("Credit 100 kr")).toBeTruthy();
    expect(screen.queryByText(/You owe/)).toBeNull();
    expect(screen.getByText("100 kr credit left")).toBeTruthy();
  });

  it("shows a settled balance", async () => {
    stubApi({ balanceSek: 0, owedSek: 0, creditSek: 0, items: [] });
    renderMoney();
    expect(await screen.findByText("You're all paid up")).toBeTruthy();
    expect(screen.getByText(/No charges or payments yet/)).toBeTruthy();
  });

  it("shows how to pay: bank details, instructions and the payment reference with copy", async () => {
    stubApi(owing);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderMoney();
    const howTo = await screen.findByRole("region", { name: "How to pay" });
    await within(howTo).findByText("BOLT-ALEX");
    expect(within(howTo).getByText("5050-1055")).toBeTruthy();
    expect(within(howTo).getByText("SE4550000000058398257466")).toBeTruthy();
    expect(within(howTo).getByText("Bolt IF")).toBeTruthy();
    expect(within(howTo).getByText("Pay within 14 days.")).toBeTruthy();

    fireEvent.click(within(howTo).getByRole("button", { name: "Copy payment reference" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("BOLT-ALEX");
    });
    expect(await screen.findByText("Payment reference copied")).toBeTruthy();
  });

  it("still shows the ledger when settings or profile cannot be read", async () => {
    stubApi(owing, { settings: {}, profile: {} });
    renderMoney();
    expect(await screen.findByText("You owe 90 kr")).toBeTruthy();
    const howTo = screen.getByRole("region", { name: "How to pay" });
    expect(await within(howTo).findByText(/Ask the treasurer/)).toBeTruthy();
  });

  it("shows an error with retry when the ledger fails", async () => {
    const fetchMock = stubApi(500);
    renderMoney();
    expect(await screen.findByRole("alert")).toBeTruthy();
    stubApi(owing);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("You owe 90 kr")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalled();
  });
});
