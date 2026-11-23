import type { Context, MiddlewareHandler } from "hono";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** One structured log line. Every line emitted during a request carries its `requestId`. */
export interface LogLine {
  level: LogLevel;
  event: string;
  ts: number;
  requestId: string;
  [field: string]: unknown;
}

export type LogSink = (line: LogLine) => void;

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface OpsVariables {
  requestId: string;
  logger: Logger;
}

export type OpsEnv = { Variables: OpsVariables };

export const REQUEST_ID_HEADER = "x-request-id";

/** Accept a client-supplied ID only if it is short and log-safe (no newlines or spaces). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Writes one JSON object per line. Workers Logs (free) indexes these fields. */
export const consoleSink: LogSink = (line) => {
  console.log(JSON.stringify(line));
};

export function createLogger(options: {
  requestId: string;
  sink: LogSink;
  now: () => number;
}): Logger {
  const write =
    (level: LogLevel) =>
    (event: string, fields: Record<string, unknown> = {}): void => {
      options.sink({ ...fields, level, event, ts: options.now(), requestId: options.requestId });
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

export function requestIdMiddleware(options: {
  sink?: LogSink;
  now: () => number;
}): MiddlewareHandler<OpsEnv> {
  const sink = options.sink ?? consoleSink;
  return async (c: Context<OpsEnv>, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const requestId =
      incoming !== undefined && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();

    c.set("requestId", requestId);
    c.set("logger", createLogger({ requestId, sink, now: options.now }));

    const startedAt = options.now();
    await next();

    c.res.headers.set(REQUEST_ID_HEADER, requestId);
    c.var.logger.info("request.completed", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      duration_ms: options.now() - startedAt,
    });
  };
}
