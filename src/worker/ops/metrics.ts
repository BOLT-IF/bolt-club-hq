import type { LogSink } from "./logging";

/**
 * Sink for launch metrics. Production wires this to the structured log (Workers
 * Logs, free), so counts can be derived with a saved query. The interface stays
 * small so a later Analytics Engine sink needs no caller changes.
 */
export interface CounterSink {
  increment(name: string, labels?: Record<string, string>): void;
  observe(name: string, value: number, labels?: Record<string, string>): void;
}

export interface LaunchCounters {
  /** Link-RSVP outcome: "rsvped" when the link led to an RSVP, "viewed" otherwise. */
  linkRsvp(outcome: "rsvped" | "viewed"): void;
  /** Push opt-in outcome for a member who saw the prompt. */
  pushOptIn(optedIn: boolean): void;
  /** Milliseconds from a payment claim to its confirmation. */
  claimToConfirmation(durationMs: number): void;
}

export function createLaunchCounters(sink: CounterSink): LaunchCounters {
  return {
    linkRsvp: (outcome) => {
      sink.increment("launch.link_rsvp", { outcome });
    },
    pushOptIn: (optedIn) => {
      sink.increment("launch.push_opt_in", { opted_in: String(optedIn) });
    },
    claimToConfirmation: (durationMs) => {
      sink.observe("launch.claim_to_confirmation_ms", durationMs, {});
    },
  };
}

/** Counter sink that emits each metric as one structured log line. */
export function logCounterSink(log: LogSink, requestId: string, now: () => number): CounterSink {
  const emit = (metric: string, fields: Record<string, unknown>): void => {
    log({ level: "info", event: "metric", ts: now(), requestId, metric, ...fields });
  };
  return {
    increment: (name, labels = {}) => {
      emit(name, { kind: "counter", labels });
    },
    observe: (name, value, labels = {}) => {
      emit(name, { kind: "histogram", value, labels });
    },
  };
}
