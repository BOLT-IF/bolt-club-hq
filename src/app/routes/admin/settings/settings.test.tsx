import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../api/client";
import { ToastProvider } from "../../../components/ui/Toast";
import { registeredFrontendRoutes } from "../../registry";
import SettingsPage from "./SettingsPage";

const loaded = {
  clubName: "BOLT IF",
  bank: {
    accountHolder: "BOLT IF",
    bankName: "Swedbank",
    accountNumber: "8327-9 123 456 789-0",
    iban: "SE4550000000058398257466",
    bankgiro: "5402-9681",
  },
  paymentInstructions: null,
  quietHours: { start: "22:00", end: "08:00" },
  passUnpaidRevokeDays: 21,
  autoPromoteCutoffMin: 180,
  clubFeeFallSek: 160,
  clubFeeSpringSek: 85,
  defaults: {},
  accountCodes: {},
  rosterAppUrl: null,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPage() {
  return render(
    <ToastProvider>
      <SettingsPage />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  configureApiClient({});
  vi.restoreAllMocks();
});

describe("admin settings page", () => {
  type Call = { url: string; method: string; body: unknown };
  let calls: Call[];
  let respond: (call: Call) => Response;

  beforeEach(() => {
    calls = [];
    respond = (call) => (call.method === "PUT" ? json(200, call.body) : json(200, loaded));
    configureApiClient({
      fetch: (url, init) => {
        const raw = init?.body;
        const call: Call = {
          url,
          method: init?.method ?? "GET",
          body: typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined,
        };
        calls.push(call);
        return Promise.resolve(respond(call));
      },
    });
  });

  it("registers at /admin/settings", () => {
    expect(registeredFrontendRoutes().map((r) => r.path)).toContain("/admin/settings");
  });

  it("loads the saved settings into labelled fields", async () => {
    renderPage();
    expect(await screen.findByLabelText("Club Name")).toHaveProperty("value", "BOLT IF");
    expect(screen.getByLabelText("Account Holder")).toHaveProperty("value", "BOLT IF");
    expect(screen.getByLabelText("Bank Name")).toHaveProperty("value", "Swedbank");
    expect(screen.getByLabelText("Account Number")).toHaveProperty("value", "8327-9 123 456 789-0");
    expect(screen.getByLabelText("IBAN (Optional)")).toHaveProperty(
      "value",
      "SE4550000000058398257466",
    );
    expect(screen.getByLabelText("Bankgiro (Optional)")).toHaveProperty("value", "5402-9681");
    expect(screen.getByLabelText("Roster App URL")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Days Before Unpaid Pass Revocation")).toHaveProperty(
      "value",
      "21",
    );
    expect(screen.getByLabelText("Fall Club Fee (kr)")).toHaveProperty("value", "160");
    expect(screen.getByLabelText("Spring Joining Fee (kr)")).toHaveProperty("value", "85");
  });

  it("saves edits with PUT /admin/settings, including bank name and account number without IBAN or bankgiro", async () => {
    renderPage();
    const url = await screen.findByLabelText("Roster App URL");
    fireEvent.change(url, { target: { value: "https://roster.example.se" } });
    fireEvent.change(screen.getByLabelText("Fall Club Fee (kr)"), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText("Spring Joining Fee (kr)"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByLabelText("Bank Name"), { target: { value: "Handelsbanken" } });
    fireEvent.change(screen.getByLabelText("Account Number"), {
      target: { value: "6101 123 456 789" },
    });
    fireEvent.change(screen.getByLabelText("IBAN (Optional)"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Bankgiro (Optional)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    expect(await screen.findByText("Settings saved")).toBeTruthy();
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.url).toBe("/api/v1/admin/settings");
    expect(put.body).toMatchObject({
      clubName: "BOLT IF",
      bank: {
        accountHolder: "BOLT IF",
        bankName: "Handelsbanken",
        accountNumber: "6101 123 456 789",
      },
      rosterAppUrl: "https://roster.example.se",
      passUnpaidRevokeDays: 21,
      clubFeeFallSek: 200,
      clubFeeSpringSek: 100,
    });
    expect((put.body as { bank: Record<string, unknown> }).bank).not.toHaveProperty("iban");
    expect((put.body as { bank: Record<string, unknown> }).bank).not.toHaveProperty("bankgiro");
  });

  it("shows the server's field errors next to the field", async () => {
    respond = (call) =>
      call.method === "PUT"
        ? json(400, {
            error: "validation",
            fields: {
              "bank.iban": "Enter a valid IBAN",
              "bank.accountNumber": "Enter a valid bank account number",
              "bank.bankName": "Use up to 80 characters",
            },
          })
        : json(200, loaded);
    renderPage();
    await screen.findByLabelText("IBAN (Optional)");
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    const iban = await screen.findByLabelText("IBAN (Optional)");
    const accountNumber = screen.getByLabelText("Account Number");
    const bankName = screen.getByLabelText("Bank Name");
    await waitFor(() => {
      expect(iban.getAttribute("aria-invalid")).toBe("true");
      expect(accountNumber.getAttribute("aria-invalid")).toBe("true");
      expect(bankName.getAttribute("aria-invalid")).toBe("true");
    });
    expect(screen.getByText("Enter a valid IBAN")).toBeTruthy();
    expect(screen.getByText("Enter a valid bank account number")).toBeTruthy();
    expect(screen.getByText("Use up to 80 characters")).toBeTruthy();
  });

  it("tells a non-admin they cannot open it", async () => {
    respond = () => json(403, { error: "forbidden" });
    renderPage();
    expect(await screen.findByText("Admins only")).toBeTruthy();
  });
});
