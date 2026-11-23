import { Toucan } from "toucan-js";

/** Sentry DSN, read from the `SENTRY_DSN` secret or var. Unset means Sentry is disabled. */
export interface SentryEnv {
  SENTRY_DSN?: string;
}

/**
 * Builds a toucan-js client for the Worker, or returns null when no DSN is set
 * (local dev and tests). Callers treat null as "report nothing".
 */
export function createSentry(
  env: SentryEnv,
  request: Request,
  ctx: Pick<ExecutionContext, "waitUntil">,
  options: { environment: string; release?: string },
): Toucan | null {
  if (!env.SENTRY_DSN) {
    return null;
  }
  return new Toucan({
    dsn: env.SENTRY_DSN,
    request,
    context: ctx,
    environment: options.environment,
    ...(options.release === undefined ? {} : { release: options.release }),
    // Free plan: keep the event volume low and never send personal data.
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
  });
}

/** Strips anything that could identify a member before an event leaves the Worker. */
export function scrubEvent<T extends { request?: { headers?: Record<string, string> } }>(
  event: T,
): T {
  if (event.request?.headers) {
    const headers = { ...event.request.headers };
    delete headers["authorization"];
    delete headers["cookie"];
    event.request.headers = headers;
  }
  return event;
}
