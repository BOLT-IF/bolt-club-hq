import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../api/client";
import { ToastProvider } from "../../components/ui/Toast";
import { registeredFrontendRoutes } from "../registry";
import { PrivacyPage } from "./PrivacyPage";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("privacy page (S2.5)", () => {
  const originalCreateDesc = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const originalRevokeDesc = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const originalClickDesc = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "click");
  let createObjectUrlMock: ReturnType<typeof vi.fn>;
  let revokeObjectUrlMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.history.pushState({}, "", "/privacy");
    createObjectUrlMock = vi.fn(() => "blob:privacy-export");
    revokeObjectUrlMock = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectUrlMock,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectUrlMock,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(HTMLAnchorElement.prototype, "click", {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    configureApiClient({});
    if (originalCreateDesc) Object.defineProperty(URL, "createObjectURL", originalCreateDesc);
    if (originalRevokeDesc) Object.defineProperty(URL, "revokeObjectURL", originalRevokeDesc);
    if (originalClickDesc) {
      Object.defineProperty(HTMLAnchorElement.prototype, "click", originalClickDesc);
    }
  });

  it("is auto-registered at /privacy", () => {
    expect(registeredFrontendRoutes().map((r) => r.path)).toContain("/privacy");
  });

  it("renders the privacy notice and retention windows with zero axe violations", async () => {
    const { container } = render(
      <ToastProvider>
        <PrivacyPage />
      </ToastProvider>,
    );

    expect(screen.getByRole("heading", { name: /^privacy$/i })).toBeTruthy();
    expect(screen.getByText(/7 years/i)).toBeTruthy();
    expect(screen.getByText(/1 year/i)).toBeTruthy();
    expect(screen.getByText(/6 months/i)).toBeTruthy();
    expect(screen.getByText(/90 days/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /download my data/i })).toBeTruthy();

    const results = await axe.run(container);
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("downloads the member export JSON from GET /me/export", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        json(200, {
          exportedAt: "2027-06-01T12:00:00.000Z",
          member: { id: "mem_1", displayName: "Ada Lovelace" },
        }),
      ),
    );
    configureApiClient({ fetch: fetchMock });

    render(
      <ToastProvider>
        <PrivacyPage />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /download my data/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/me/export",
        expect.objectContaining({ method: "GET" }),
      );
    });
    expect(await screen.findByText(/your data export is ready/i)).toBeTruthy();
    expect(createObjectUrlMock).toHaveBeenCalledOnce();
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:privacy-export");
  });

  it("shows an accessible error when export is forbidden or fails", async () => {
    configureApiClient({
      fetch: vi.fn(() => Promise.resolve(json(403, { error: "forbidden" }))),
    });

    render(
      <ToastProvider>
        <PrivacyPage />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /download my data/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/cannot export/i);
  });
});
