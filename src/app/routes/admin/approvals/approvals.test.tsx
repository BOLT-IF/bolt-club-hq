import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureApiClient } from "../../../api/client";
import { ToastProvider } from "../../../components/ui/Toast";
import { registeredFrontendRoutes } from "../../registry";
import { AdminApprovals } from "./AdminApprovals";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const nina = {
  id: "jr1",
  memberId: "m9",
  displayName: "Nina New",
  email: "nina@example.com",
  via: "event_link",
  source: "Thu open",
  createdAt: "2027-03-01T09:00:00.000Z",
};
const invite = {
  id: "inv1",
  token: "abcdefghjkmnpqrs23456789",
  expiresAt: "2027-03-15T09:00:00.000Z",
  maxUses: 10,
  uses: 2,
  revokedAt: null,
  state: "active",
};

function setup(post: (path: string, body: unknown) => Response = () => json(200, {})) {
  let requests = [nina];
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  configureApiClient({
    onUnauthorized: () => undefined,
    fetch: (input, init) => {
      const path = input.replace("/api/v1", "");
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path === "/admin/join-requests")
        return Promise.resolve(json(200, { requests }));
      if (method === "GET" && path === "/invites")
        return Promise.resolve(json(200, { invites: [invite] }));
      if (method === "GET" && path === "/admin/members")
        return Promise.resolve(json(200, { members: [] }));
      const res = post(path, body);
      if (res.ok && path.startsWith("/join-requests/")) requests = [];
      return Promise.resolve(res);
    },
  });
  render(
    <ToastProvider>
      <AdminApprovals />
    </ToastProvider>,
  );
  return calls;
}

beforeEach(() => {
  window.history.pushState({}, "", "/admin/approvals");
});
afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("admin approvals page", () => {
  it("is registered at /admin/approvals", () => {
    expect(registeredFrontendRoutes().map((r) => r.path)).toContain("/admin/approvals");
  });

  it("lists pending requests with name, email and where they came from", async () => {
    setup();
    const item = await screen.findByRole("listitem", { name: /Nina New/ });
    expect(within(item).getByText(/nina@example.com/)).toBeTruthy();
    expect(within(item).getByText(/Event link: Thu open/)).toBeTruthy();
  });

  it("approve posts and refreshes the queue", async () => {
    const calls = setup();
    const item = await screen.findByRole("listitem", { name: /Nina New/ });
    fireEvent.click(within(item).getByRole("button", { name: "Approve Nina New" }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "POST",
        path: "/join-requests/jr1/approve",
        body: undefined,
      });
    });
    expect(await screen.findByText(/No one is waiting/i)).toBeTruthy();
  });

  it("reject asks for confirmation first", async () => {
    const calls = setup();
    const item = await screen.findByRole("listitem", { name: /Nina New/ });
    fireEvent.click(within(item).getByRole("button", { name: "Reject Nina New" }));
    expect(calls.some((c) => c.path.endsWith("/reject"))).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Reject request" }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "POST",
        path: "/join-requests/jr1/reject",
        body: undefined,
      });
    });
  });

  it("creates an invite with expiry and max uses and shows its link", async () => {
    const calls = setup((path) =>
      path === "/invites"
        ? json(201, { invite: { ...invite, id: "inv2", token: "newtoken" } })
        : json(200, {}),
    );
    await screen.findByRole("listitem", { name: /Nina New/ });
    fireEvent.change(screen.getByLabelText("Valid for (days)"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Max uses"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: "POST",
        path: "/invites",
        body: { expiresInDays: 7, maxUses: 3 },
      });
    });
    expect(await screen.findByDisplayValue(/\/join\/newtoken$/)).toBeTruthy();
  });

  it("lists invites and revokes one after confirmation", async () => {
    const calls = setup();
    const row = await screen.findByRole("listitem", { name: /Invite used 2 of 10/ });
    fireEvent.click(within(row).getByRole("button", { name: /Revoke/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke invite" }));
    await waitFor(() => {
      expect(calls).toContainEqual({ method: "DELETE", path: "/invites/inv1", body: undefined });
    });
  });

  it("shows pending members who signed in without an invite and lets admin approve them", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    let pendingMembers = [
      {
        id: "m_direct",
        displayName: "Sam Direct",
        rosterName: null,
        email: "sam@example.com",
        role: "member",
        status: "pending",
        paymentRef: "BC-SAM",
      },
    ];
    configureApiClient({
      onUnauthorized: () => undefined,
      fetch: (input, init) => {
        const path = input.replace("/api/v1", "");
        const method = init?.method ?? "GET";
        calls.push({ method, path });
        if (method === "GET" && path === "/admin/join-requests")
          return Promise.resolve(json(200, { requests: [] }));
        if (method === "GET" && path === "/invites")
          return Promise.resolve(json(200, { invites: [] }));
        if (method === "GET" && path === "/admin/members")
          return Promise.resolve(json(200, { members: pendingMembers }));
        if (method === "POST" && path === "/members/m_direct/approve") {
          pendingMembers = [];
          return Promise.resolve(json(200, { memberId: "m_direct", status: "active" }));
        }
        return Promise.resolve(json(200, {}));
      },
    });
    render(
      <ToastProvider>
        <AdminApprovals />
      </ToastProvider>,
    );
    const item = await screen.findByRole("listitem", { name: /Sam Direct/ });
    fireEvent.click(within(item).getByRole("button", { name: "Approve Sam Direct" }));
    await waitFor(() => {
      expect(calls).toContainEqual({ method: "POST", path: "/members/m_direct/approve" });
    });
    expect(await screen.findByText(/No one is waiting/i)).toBeTruthy();
  });
});
