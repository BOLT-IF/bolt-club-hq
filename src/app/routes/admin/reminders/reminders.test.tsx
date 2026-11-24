import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApiClient } from "../../../api/client";
import { ToastProvider } from "../../../components/ui";
import { registeredFrontendRoutes } from "../../registry";

interface RuleDto {
  id: string;
  kind: "payment_due" | "event_unrsvped";
  enabled: boolean;
  minIntervalDays: number;
  template: string;
  params: { thresholdSek: number } | { atPublish: boolean; hoursBeforeClose: number | null };
}

const PLACEHOLDERS = {
  payment_due: ["name", "balance", "paymentRef"],
  event_unrsvped: ["name", "event", "when", "closes"],
};

const PAYMENT_RULE: RuleDto = {
  id: "rr_pay_1",
  kind: "payment_due",
  enabled: true,
  minIntervalDays: 90,
  template: "Hi {name}, you owe {balance} kr (ref {paymentRef}).",
  params: { thresholdSek: 300 },
};

const EVENT_RULE: RuleDto = {
  id: "rr_evt_1",
  kind: "event_unrsvped",
  enabled: false,
  minIntervalDays: 1,
  template: "{name}, {event} starts {when} (closes {closes}).",
  params: { atPublish: true, hoursBeforeClose: 24 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stubApi(handler: FetchHandler) {
  const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>((url, init) =>
    Promise.resolve(handler(url, init)),
  );
  configureApiClient({ fetch: fetchMock });
  return fetchMock;
}

function renderPage() {
  const route = registeredFrontendRoutes().find((r) => r.path === "/admin/reminders");
  expect(route).toBeDefined();
  const Component = route!.component;
  return render(
    <ToastProvider>
      <Component />
    </ToastProvider>,
  );
}

describe("admin reminders screen (S6.5b)", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/admin/reminders");
  });

  afterEach(() => {
    cleanup();
    configureApiClient({});
    vi.restoreAllMocks();
  });

  it("registers /admin/reminders", () => {
    expect(registeredFrontendRoutes().map((r) => r.path)).toContain("/admin/reminders");
  });

  it("members get 403 and see an admins-only state cleanly", async () => {
    stubApi(() => json({ error: "forbidden" }, 403));
    renderPage();
    expect(await screen.findByText("Admins only")).toBeTruthy();
    expect(screen.getByText(/admin access/i)).toBeTruthy();
  });

  it("lists rules and renders placeholders from /admin/reminder-rules for each kind", async () => {
    stubApi(() => json({ items: [PAYMENT_RULE, EVENT_RULE], placeholders: PLACEHOLDERS }));
    renderPage();

    expect(await screen.findByText(/you owe \{balance\} kr/i)).toBeTruthy();
    expect(screen.getByText(/\{event\} starts \{when\}/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New rule" }));

    // Payment due placeholders render from API response
    expect(screen.getByRole("button", { name: "{name}" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "{balance}" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "{paymentRef}" })).toBeTruthy();

    // Switching kind renders event_unrsvped placeholders
    fireEvent.change(screen.getByLabelText("Rule kind"), {
      target: { value: "event_unrsvped" },
    });
    expect(screen.getByRole("button", { name: "{event}" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "{when}" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "{closes}" })).toBeTruthy();
  });

  it("rejects an unknown placeholder before saving", async () => {
    const fetchMock = stubApi((url, init) => {
      if (url === "/api/v1/admin/reminder-rules" && (init?.method ?? "GET") === "GET") {
        return json({ items: [], placeholders: PLACEHOLDERS });
      }
      return json({ error: "validation", fields: { template: "unknown placeholder: {bogus}" } }, 400);
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    fireEvent.change(screen.getByLabelText("Minimum balance owed (kr)"), {
      target: { value: "300" },
    });
    fireEvent.change(screen.getByLabelText("Message template"), {
      target: { value: "Hello {bogus}!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));

    const templateInput = await screen.findByLabelText("Message template");
    await waitFor(() => {
      expect(templateInput.getAttribute("aria-invalid")).toBe("true");
    });
    expect(screen.getByText(/unknown placeholder.*\{bogus\}/i)).toBeTruthy();
    // Only the initial GET should have run
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("displays server validation errors next to fields", async () => {
    stubApi((url, init) => {
      if (url === "/api/v1/admin/reminder-rules" && (init?.method ?? "GET") === "GET") {
        return json({ items: [], placeholders: PLACEHOLDERS });
      }
      return json(
        { error: "validation", fields: { template: "unknown placeholder: {serverBad}" } },
        400,
      );
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    fireEvent.change(screen.getByLabelText("Minimum balance owed (kr)"), {
      target: { value: "300" },
    });
    fireEvent.change(screen.getByLabelText("Message template"), {
      target: { value: "Hi {name}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));

    expect(await screen.findByText(/unknown placeholder: \{serverBad\}/i)).toBeTruthy();
  });

  it("creates payment_due and event_unrsvped rules with Idempotency-Key and supports editing", async () => {
    let items: RuleDto[] = [PAYMENT_RULE];
    const fetchMock = stubApi((url, init) => {
      const method = init?.method ?? "GET";
      if (url === "/api/v1/admin/reminder-rules" && method === "GET") {
        return json({ items, placeholders: PLACEHOLDERS });
      }
      if (url === "/api/v1/admin/reminder-rules" && method === "POST") {
        const created: RuleDto = {
          id: "rr_new",
          ...(JSON.parse(init?.body as string) as Omit<RuleDto, "id">),
        };
        items = [...items, created];
        return json(created, 201);
      }
      if (url === `/api/v1/admin/reminder-rules/${PAYMENT_RULE.id}` && method === "PUT") {
        const updated: RuleDto = {
          id: PAYMENT_RULE.id,
          ...(JSON.parse(init?.body as string) as Omit<RuleDto, "id">),
        };
        items = items.map((r) => (r.id === PAYMENT_RULE.id ? updated : r));
        return json(updated);
      }
      return json({ error: "not_found" }, 404);
    });

    renderPage();
    await screen.findByText(/you owe \{balance\} kr/i);

    // Create event_unrsvped rule
    fireEvent.click(screen.getByRole("button", { name: "New rule" }));
    fireEvent.change(screen.getByLabelText("Rule kind"), { target: { value: "event_unrsvped" } });
    fireEvent.click(screen.getByLabelText(/when event opens/i));
    fireEvent.change(screen.getByLabelText(/hours before rsvp closes/i), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByLabelText("Message template"), {
      target: { value: "Join {event}!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, i]) => i?.method === "POST");
      expect(post).toBeDefined();
      expect(new Headers(post![1]?.headers).get("Idempotency-Key")).toBeTruthy();
      expect(JSON.parse(post![1]?.body as string)).toEqual({
        kind: "event_unrsvped",
        enabled: true,
        minIntervalDays: 1,
        template: "Join {event}!",
        params: { atPublish: true, hoursBeforeClose: 12 },
      });
    });

    // Edit existing rule
    const editButtons = await screen.findAllByRole("button", { name: "Edit" });
    fireEvent.click(editButtons[0]!);
    fireEvent.change(screen.getByLabelText("Minimum balance owed (kr)"), {
      target: { value: "500" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([u, i]) => u === `/api/v1/admin/reminder-rules/${PAYMENT_RULE.id}` && i?.method === "PUT",
      );
      expect(put).toBeDefined();
      expect(JSON.parse(put![1]?.body as string)).toMatchObject({
        kind: "payment_due",
        params: { thresholdSek: 500 },
      });
    });
  });

  it("toggles enabled state and previews recipients", async () => {
    let current = { ...PAYMENT_RULE };
    const fetchMock = stubApi((url, init) => {
      const method = init?.method ?? "GET";
      if (url === "/api/v1/admin/reminder-rules" && method === "GET") {
        return json({ items: [current], placeholders: PLACEHOLDERS });
      }
      if (url === `/api/v1/admin/reminder-rules/${PAYMENT_RULE.id}` && method === "PUT") {
        current = { id: current.id, ...(JSON.parse(init?.body as string) as Omit<RuleDto, "id">) };
        return json(current);
      }
      if (url === `/api/v1/admin/reminder-rules/${PAYMENT_RULE.id}/preview` && method === "POST") {
        return json({
          count: 2,
          recipients: [
            { memberId: "m1", displayName: "Alex" },
            { memberId: "m2", displayName: "Sam" },
          ],
          sample: {
            title: "Payment reminder",
            body: "Hi Alex, you owe 450 kr (ref BOLT-ALEX).",
            link: "/money",
          },
        });
      }
      return json({ error: "not_found" }, 404);
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));

    const dialog = await screen.findByRole("dialog", { name: /preview/i });
    expect(dialog.textContent).toContain("2 members");
    expect(dialog.textContent).toContain("Alex");
    expect(dialog.textContent).toContain("Sam");
    expect(dialog.textContent).toContain("Hi Alex, you owe 450 kr (ref BOLT-ALEX).");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, i]) => i?.method === "PUT");
      expect(put).toBeDefined();
      expect(JSON.parse(put![1]?.body as string)).toMatchObject({ enabled: false });
    });
    expect(await screen.findByRole("button", { name: "Enable" })).toBeTruthy();
  });

  it("handles 409 rule_has_sends on delete by offering to disable instead", async () => {
    let current = { ...PAYMENT_RULE };
    const fetchMock = stubApi((url, init) => {
      const method = init?.method ?? "GET";
      if (url === "/api/v1/admin/reminder-rules" && method === "GET") {
        return json({ items: [current], placeholders: PLACEHOLDERS });
      }
      if (url === `/api/v1/admin/reminder-rules/${PAYMENT_RULE.id}` && method === "DELETE") {
        return json({ error: "rule_has_sends" }, 409);
      }
      if (url === `/api/v1/admin/reminder-rules/${PAYMENT_RULE.id}` && method === "PUT") {
        current = { id: current.id, ...(JSON.parse(init?.body as string) as Omit<RuleDto, "id">) };
        return json(current);
      }
      return json({ error: "not_found" }, 404);
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete rule" }));

    // 409 explains and offers to disable instead
    expect(await screen.findByText(/already sent reminders/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disable instead" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([u, i]) => u === `/api/v1/admin/reminder-rules/${PAYMENT_RULE.id}` && i?.method === "PUT",
      );
      expect(put).toBeDefined();
      expect(JSON.parse(put![1]?.body as string)).toMatchObject({ enabled: false });
    });
    expect(await screen.findByRole("button", { name: "Enable" })).toBeTruthy();
  });
});
