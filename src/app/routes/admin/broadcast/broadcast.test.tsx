import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../api/client";
import { ToastProvider } from "../../../components/ui";
import { registeredFrontendRoutes } from "../../registry";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubApi(respond: () => Response = () => json({ broadcastId: "b", recipientCount: 12 })) {
  const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(respond()),
  );
  configureApiClient({ fetch: fetchMock });
  return fetchMock;
}

function renderPage() {
  const route = registeredFrontendRoutes().find((r) => r.path === "/admin/broadcast");
  expect(route).toBeDefined();
  const Component = route!.component;
  render(
    <ToastProvider>
      <Component />
    </ToastProvider>,
  );
}

const fill = (title: string, body: string) => {
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: title } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: body } });
};

describe("admin broadcast screen", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/admin/broadcast");
  });
  afterEach(() => {
    cleanup();
    configureApiClient({});
  });

  it("registers /admin/broadcast", () => {
    expect(registeredFrontendRoutes().map((r) => r.path)).toContain("/admin/broadcast");
  });

  it("has labelled fields and the four audiences", () => {
    stubApi();
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Broadcast" })).toBeTruthy();
    const audience = screen.getByLabelText<HTMLSelectElement>("Send To");
    expect([...audience.options].map((o) => o.value)).toEqual([
      "all",
      "pass_holders",
      "event_rsvps",
      "captains",
    ]);
  });

  it("cannot send an empty message", () => {
    const fetchMock = stubApi();
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Review & Send" }));
    expect(screen.getByRole("alert").textContent).toMatch(/title/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for confirmation, then posts once with an Idempotency-Key", async () => {
    const fetchMock = stubApi();
    renderPage();
    fill("Hall closed", "No play on Monday");
    fireEvent.click(screen.getByRole("button", { name: "Review & Send" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Send Broadcast" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/admin/broadcasts");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBeTruthy();
    expect(JSON.parse(init?.body as string) as unknown).toEqual({
      title: "Hall closed",
      body: "No play on Monday",
      audience: { kind: "all" },
    });
    expect(await screen.findByText(/sent to 12 members/i)).toBeTruthy();
  });

  it("an event audience asks for the event and sends it", async () => {
    const fetchMock = stubApi();
    renderPage();
    fireEvent.change(screen.getByLabelText("Send To"), { target: { value: "event_rsvps" } });
    fill("Court change", "Court 3");
    fireEvent.click(screen.getByRole("button", { name: "Review & Send" }));
    expect(screen.getByRole("alert").textContent).toMatch(/event/i);
    fireEvent.change(screen.getByLabelText("Event ID or Share Slug"), {
      target: { value: "evt_1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review & Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send Broadcast" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toMatchObject({
      audience: { kind: "event_rsvps", eventId: "evt_1" },
    });
  });

  it("shows an error and keeps the draft when sending fails", async () => {
    stubApi(() => json({ error: "event_not_found" }, 404));
    renderPage();
    fill("Hi", "There");
    fireEvent.click(screen.getByRole("button", { name: "Review & Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send Broadcast" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Title").value).toBe("Hi");
  });
});
