import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../api/client";
import { ToastProvider } from "../../../components/ui/Toast";
import { registeredFrontendRoutes } from "../../registry";
import SettingsPage from "./SettingsPage";

const loaded = {
  clubName: "BOLT IF",
  bank: { accountHolder: "BOLT IF", iban: "SE4550000000058398257466", bankgiro: "5402-9681" },
  paymentInstructions: null,
  quietHours: { start: "22:00", end: "08:00" },
  passUnpaidRevokeDays: 21,
  autoPromoteCutoffMin: 180,
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
    expect(await screen.findByLabelText("Club name")).toHaveProperty("value", "BOLT IF");
    expect(screen.getByLabelText("IBAN")).toHaveProperty("value", "SE4550000000058398257466");
    expect(screen.getByLabelText("Bankgiro")).toHaveProperty("value", "5402-9681");
    expect(screen.getByLabelText("Roster app URL")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Days before an unpaid pass can be revoked")).toHaveProperty(
      "value",
      "21",
    );
  });

  it("saves edits with PUT /admin/settings", async () => {
    renderPage();
    const url = await screen.findByLabelText("Roster app URL");
    fireEvent.change(url, { target: { value: "https://roster.example.se" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByText("Settings saved")).toBeTruthy();
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.url).toBe("/api/v1/admin/settings");
    expect(put.body).toMatchObject({
      clubName: "BOLT IF",
      rosterAppUrl: "https://roster.example.se",
      passUnpaidRevokeDays: 21,
    });
  });

  it("shows the server's field errors next to the field", async () => {
    respond = (call) =>
      call.method === "PUT"
        ? json(400, { error: "validation", fields: { "bank.iban": "Enter a valid IBAN" } })
        : json(200, loaded);
    renderPage();
    await screen.findByLabelText("IBAN");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    const iban = await screen.findByLabelText("IBAN");
    await waitFor(() => {
      expect(iban.getAttribute("aria-invalid")).toBe("true");
    });
    expect(screen.getByText("Enter a valid IBAN")).toBeTruthy();
  });

  it("tells a non-admin they cannot open it", async () => {
    respond = () => json(403, { error: "forbidden" });
    renderPage();
    expect(await screen.findByText("Admins only")).toBeTruthy();
  });
});
