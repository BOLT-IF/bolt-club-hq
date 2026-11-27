import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../api/client";
import { registeredFrontendRoutes } from "../../registry";
import { AdminAudit, stockholmDayStartUtc } from "./AdminAudit";

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  at: "2027-02-01T10:00:00.000Z",
  actorId: "m1",
  actorName: "Ada Admin",
  action: "member.role_change",
  entity: "member",
  entityId: "m2",
  before: { role: "member" },
  after: { role: "admin" },
  ...over,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup(answer: (path: string) => Response) {
  const paths: string[] = [];
  const fetch = vi.fn((input: string) => {
    const path = input.replace("/api/v1", "");
    paths.push(path);
    if (path.startsWith("/admin/members")) {
      return Promise.resolve(
        json(200, {
          members: [
            { id: "m1", displayName: "Ada Admin" },
            { id: "m2", displayName: "Bo Berg" },
          ],
        }),
      );
    }
    return Promise.resolve(answer(path));
  });
  configureApiClient({ fetch });
  render(<AdminAudit />);
  return paths;
}

const auditCalls = (paths: string[]) => paths.filter((p) => p.startsWith("/admin/audit"));

beforeEach(() => {
  window.history.pushState({}, "", "/admin/audit");
});
afterEach(() => {
  cleanup();
  configureApiClient({});
});

describe("admin audit page", () => {
  it("is registered at /admin/audit", () => {
    expect(registeredFrontendRoutes().map((r) => r.path)).toContain("/admin/audit");
  });

  it("lists entries with who, what, which entity, Stockholm time and the change", async () => {
    setup(() =>
      json(200, {
        entries: [entry("a1"), entry("a2", { actorId: null, actorName: null })],
        nextCursor: null,
      }),
    );
    const item = await screen.findByRole("listitem", { name: /member.role_change by Ada Admin/ });
    expect(within(item).getByText("member m2")).toBeTruthy();
    // 10:00 UTC is 11:00 in Stockholm in February.
    expect(within(item).getByText(/11:00/)).toBeTruthy();
    expect(within(item).getByText(/"role": "admin"/)).toBeTruthy();
    expect(screen.getByRole("listitem", { name: /by System/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("filters send actor, entity, action and a Stockholm date range", async () => {
    const paths = setup(() => json(200, { entries: [], nextCursor: null }));
    await screen.findByText(/No audit entries/i);
    await screen.findByRole("option", { name: "Bo Berg" });
    fireEvent.change(screen.getByLabelText("Actor"), { target: { value: "m2" } });
    fireEvent.change(screen.getByLabelText("Entity"), { target: { value: "event" } });
    fireEvent.change(screen.getByLabelText("Entity ID"), { target: { value: "evt_1" } });
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "event.create" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2027-02-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2027-02-28" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply Filters" }));
    await waitFor(() => {
      expect(auditCalls(paths)).toHaveLength(2);
    });
    const q = new URLSearchParams(auditCalls(paths)[1]!.split("?")[1]);
    expect(q.get("actor")).toBe("m2");
    expect(q.get("entity")).toBe("event");
    expect(q.get("entityId")).toBe("evt_1");
    expect(q.get("action")).toBe("event.create");
    expect(q.get("from")).toBe("2027-01-31T23:00:00.000Z");
    // "To" is inclusive in the UI: the API gets the start of the next day.
    expect(q.get("to")).toBe("2027-02-28T23:00:00.000Z");
    expect(q.get("cursor")).toBeNull();
  });

  it("load more passes the cursor and appends the next page", async () => {
    const paths = setup((path) =>
      path.includes("cursor=")
        ? json(200, { entries: [entry("a2", { action: "member.update" })], nextCursor: null })
        : json(200, { entries: [entry("a1")], nextCursor: "CUR1" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("listitem", { name: /member.update/ })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: /member.role_change/ })).toBeTruthy();
    expect(auditCalls(paths).at(-1)).toContain("cursor=CUR1");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("shows an error state when the API refuses (non-admin)", async () => {
    setup(() => json(403, { error: "forbidden" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("stockholmDayStartUtc", () => {
  it("handles winter, summer and DST-change days", () => {
    expect(stockholmDayStartUtc("2027-01-15")).toBe("2027-01-14T23:00:00.000Z");
    expect(stockholmDayStartUtc("2027-07-15")).toBe("2027-07-14T22:00:00.000Z");
    expect(stockholmDayStartUtc("2027-03-28")).toBe("2027-03-27T23:00:00.000Z");
    expect(stockholmDayStartUtc("2027-03-29")).toBe("2027-03-28T22:00:00.000Z");
    expect(stockholmDayStartUtc("2027-10-31")).toBe("2027-10-30T22:00:00.000Z");
    expect(stockholmDayStartUtc("2027-11-01")).toBe("2027-10-31T23:00:00.000Z");
  });
});
