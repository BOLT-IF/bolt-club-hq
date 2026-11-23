import { http, HttpResponse } from "msw";

/**
 * MSW fixtures for the shell (S0.4). Stories add their own handlers beside these.
 * Defaults keep every flag on except where a test overrides them.
 */
export const defaultFlags: Readonly<Record<string, boolean>> = {
  events: true,
  money: true,
  inbox: true,
};

export const shellHandlers = [
  http.get("/api/v1/config", () => HttpResponse.json({ flags: defaultFlags })),
];
