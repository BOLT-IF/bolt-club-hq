import type { RsvpCancelPort } from "./rsvp-cancel";

type Input = Parameters<RsvpCancelPort["cancelFutureRsvps"]>[0];

/** Recording fake for tests only. Never imported by production code. */
export class FakeRsvpCancel implements RsvpCancelPort {
  readonly calls: Input[] = [];
  private failure: Error | null = null;

  /** Makes the next call reject once, to test the retry path. */
  failNext(error: Error): void {
    this.failure = error;
  }

  cancelFutureRsvps(input: Input): Promise<void> {
    this.calls.push(input);
    const failure = this.failure;
    this.failure = null;
    return failure ? Promise.reject(failure) : Promise.resolve();
  }
}
