import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../api/client";
import { ToastProvider } from "../../../components/ui/Toast";
import { registeredFrontendRoutes } from "../../registry";
import { AdminMembers } from "./AdminMembers";

interface Row {
  id: string;
  displayName: string;
  rosterName: string | null;
  email: string | null;
  role: "member" | "admin";
  status: "pending" | "active" | "inactive" | "erased";
  paymentRef: string;
}

const ada: Row = {
  id: "m1",
  displayName: "Ada Lovelace",
  rosterName: null,
  email: "ada@example.com",
  role: "admin",
  status: "active",
  paymentRef: "BC-ADA",
};
const bo: Row = { ...ada, id: "m2", displayName: "Bo Berg", role: "member", paymentRef: "BC-BO" };
const cy: Row = {
  ...bo,
  id: "m3",
  displayName: "Cy Dahl",
  status: "inactive",
  paymentRef: "BC-CY",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup(
  rows: Row[],
  patch: (path: string, body: unknown) => Response = () => json(200, {}),
) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch = vi.fn((input: string, init?: RequestInit) => {
    const path = input.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (method === "GET") return Promise.resolve(json(200, { members: rows }));
    return Promise.resolve(patch(path, body));
  });
  configureApiClient({ fetch });
  render(
    <ToastProvider>
      <AdminMembers />
    </ToastProvider>,
  );
  return calls;
}

beforeEach(() => {
  window.history.pushState({}, "", "/admin/members");
});
afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("admin members page", () => {
  it("is registered at /admin/members", () => {
    expect(registeredFrontendRoutes().map((r) => r.path)).toContain("/admin/members");
  });

  it("lists members with role, status (as text) and payment reference", async () => {
    setup([ada, bo, cy]);
    const item = await screen.findByRole("listitem", { name: /Bo Berg/ });
    expect(within(item).getByText("BC-BO")).toBeTruthy();
    expect(within(item).getByText("Active")).toBeTruthy();
    expect(within(item).getByText("Member")).toBeTruthy();
    const gone = screen.getByRole("listitem", { name: /Cy Dahl/ });
    expect(within(gone).getByText("Inactive")).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: /Ada/ })).getByText("Admin")).toBeTruthy();
  });

  it("shows an empty state and an error state with retry", async () => {
    setup([]);
    expect(await screen.findByText(/No members/i)).toBeTruthy();
    cleanup();
    configureApiClient({ fetch: () => Promise.resolve(json(403, { error: "forbidden" })) });
    render(
      <ToastProvider>
        <AdminMembers />
      </ToastProvider>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("promoting asks nothing but PATCHes the role and refreshes the list", async () => {
    const calls = setup([ada, bo]);
    const item = await screen.findByRole("listitem", { name: /Bo Berg/ });
    fireEvent.click(within(item).getByRole("button", { name: "Make admin" }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "PATCH",
        path: "/members/m2/role",
        body: { role: "admin" },
      });
    });
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    });
  });

  it("deactivating goes through a confirmation that names the consequence", async () => {
    const calls = setup([ada, bo]);
    const item = await screen.findByRole("listitem", { name: /Bo Berg/ });
    fireEvent.click(within(item).getByRole("button", { name: "Deactivate" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/future RSVPs/i)).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Deactivate member" }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "PATCH",
        path: "/members/m2/status",
        body: { status: "inactive" },
      });
    });
  });

  it("an inactive member can be reactivated", async () => {
    const calls = setup([ada, cy]);
    const item = await screen.findByRole("listitem", { name: /Cy Dahl/ });
    fireEvent.click(within(item).getByRole("button", { name: "Reactivate" }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "PATCH",
        path: "/members/m3/status",
        body: { status: "active" },
      });
    });
  });

  it("shows the server's last-admin refusal in plain words", async () => {
    setup([ada], () => json(409, { error: "last_admin" }));
    const item = await screen.findByRole("listitem", { name: /Ada/ });
    fireEvent.click(within(item).getByRole("button", { name: "Make member" }));
    expect(await screen.findByText(/last admin/i)).toBeTruthy();
  });

  it("edits the payment reference and explains a clash", async () => {
    const calls = setup([ada, bo], (_path, body) =>
      (body as { paymentRef?: string }).paymentRef === "BC-ADA"
        ? json(409, { error: "payment_ref_taken" })
        : json(200, {}),
    );
    const item = await screen.findByRole("listitem", { name: /Bo Berg/ });
    fireEvent.click(within(item).getByRole("button", { name: "Edit payment reference" }));
    const input = await screen.findByLabelText("Payment reference");
    fireEvent.change(input, { target: { value: "BC-ADA" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/already used/i)).toBeTruthy();

    fireEvent.change(input, { target: { value: "BC-NEW" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "PATCH",
        path: "/members/m2",
        body: { paymentRef: "BC-NEW" },
      });
    });
  });
});
