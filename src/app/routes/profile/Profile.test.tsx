import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../api/client";
import { ToastProvider } from "../../components/ui/Toast";
import { registeredFrontendRoutes } from "../registry";
import { Profile } from "./Profile";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const me = {
  id: "m1",
  displayName: "Ada Lovelace",
  rosterName: null,
  email: "ada@example.com",
  paymentRef: "BC-ADA",
};

function setup(patchStatus = 200) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  configureApiClient({
    fetch: vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path: input.replace("/api/v1", ""),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(method === "GET" ? json(200, me) : json(patchStatus, {}));
    }),
  });
  render(
    <ToastProvider>
      <Profile />
    </ToastProvider>,
  );
  return calls;
}

beforeEach(() => {
  window.history.pushState({}, "", "/profile");
});
afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("profile page", () => {
  it("is registered at /profile", () => {
    expect(registeredFrontendRoutes().map((r) => r.path)).toContain("/profile");
  });

  it("shows labelled fields and the payment reference to quote on transfers", async () => {
    setup();
    const name = await screen.findByLabelText("Display name");
    expect((name as HTMLInputElement).value).toBe("Ada Lovelace");
    expect(screen.getByLabelText(/Roster name/)).toBeTruthy();
    expect(screen.getByText("BC-ADA")).toBeTruthy();
  });

  it("saves the roster name and display name", async () => {
    const calls = setup();
    const roster = await screen.findByLabelText(/Roster name/);
    fireEvent.change(roster, { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ada L" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PATCH",
        path: "/members/m1",
        body: { displayName: "Ada L", rosterName: "Ada" },
      }),
    );
    expect(await screen.findByText("Profile saved")).toBeTruthy();
  });

  it("blocks an empty display name with an inline error and sends nothing", async () => {
    const calls = setup();
    const name = await screen.findByLabelText("Display name");
    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Enter a display name/i)).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("tells the member when saving failed", async () => {
    setup(500);
    await screen.findByLabelText("Display name");
    fireEvent.change(screen.getByLabelText(/Roster name/), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/couldn.t save/i)).toBeTruthy();
  });
});
