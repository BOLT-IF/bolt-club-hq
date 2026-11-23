import { CLIENT_VERSION, markClientOutdated } from "../lib/clientVersion";

export { CLIENT_VERSION } from "../lib/clientVersion";

export const API_BASE = "/api/v1";
export const SIGN_IN_PATH = "/sign-in";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`API request failed with status ${String(status)}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface ApiClientConfig {
  /** Returns the Clerk session token. Clerk is wired in S1.1; until then no bearer is sent. */
  readonly getToken?: () => string | null | Promise<string | null>;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Called on 401 with the current location, so sign-in can return the user here. */
  readonly onUnauthorized?: (returnTo: string) => void;
}

export interface ApiRequestOptions {
  readonly method?: HttpMethod;
  readonly body?: unknown;
  /** Required on money and RSVP POSTs (PLAN §11.5). Use newIdempotencyKey(). */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

let config: ApiClientConfig = {};

/** Replaces the client configuration. Call with {} to reset to defaults. */
export function configureApiClient(next: ApiClientConfig): void {
  config = next;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function currentLocation(): string {
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}

function defaultOnUnauthorized(returnTo: string): void {
  if (window.location.pathname === SIGN_IN_PATH) return;
  window.location.assign(`${SIGN_IN_PATH}?return_to=${encodeURIComponent(returnTo)}`);
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return text;
  }
}

/**
 * Single entry point for API calls. Adds the bearer token, X-Client-Version and
 * Idempotency-Key. 401 sends the user to sign-in with a return-to; 426 marks the
 * client as outdated so the refresh banner shows. Other errors throw ApiError.
 */
export async function apiFetch<T = void>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const headers = new Headers({ Accept: "application/json", "X-Client-Version": CLIENT_VERSION });

  const token = await (config.getToken ?? (() => null))();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);

  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  if (options.signal) init.signal = options.signal;

  const doFetch = config.fetch ?? ((input, requestInit) => globalThis.fetch(input, requestInit));
  const response = await doFetch(`${API_BASE}${path}`, init);

  if (response.status === 401) {
    (config.onUnauthorized ?? defaultOnUnauthorized)(currentLocation());
  }
  if (response.status === 426) {
    markClientOutdated();
  }
  if (!response.ok) {
    throw new ApiError(response.status, await readBody(response));
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const data: unknown = await response.json();
  return data as T;
}
