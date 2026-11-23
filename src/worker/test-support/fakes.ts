import type {
  ChargePort,
  CurrentMember,
  CurrentMemberPort,
  NotifyPort,
  PrepaidPort,
  PublishOgPort,
  ReversePort,
} from "../core/ports";

/**
 * Recording fakes: every call is kept so tests can assert on what was requested.
 * Methods return resolved promises directly (no async body) so they satisfy the port
 * signatures without an `await` that has nothing to wait for.
 */

export class FakeNotify implements NotifyPort {
  readonly calls: Array<Parameters<NotifyPort["notify"]>[0]> = [];
  notify(input: Parameters<NotifyPort["notify"]>[0]): Promise<void> {
    this.calls.push(input);
    return Promise.resolve();
  }
}

export class FakePrepaid implements PrepaidPort {
  readonly calls: Array<Parameters<PrepaidPort["isPrepaid"]>[0]> = [];
  private readonly prepaid = new Set<string>();

  markPrepaid(memberId: string, eventId: string): void {
    this.prepaid.add(`${memberId}:${eventId}`);
  }

  isPrepaid(input: Parameters<PrepaidPort["isPrepaid"]>[0]): Promise<boolean> {
    this.calls.push(input);
    return Promise.resolve(this.prepaid.has(`${input.memberId}:${input.eventId}`));
  }
}

export class FakeCharge implements ChargePort {
  readonly calls: Array<Parameters<ChargePort["charge"]>[0]> = [];
  charge(input: Parameters<ChargePort["charge"]>[0]): Promise<void> {
    this.calls.push(input);
    return Promise.resolve();
  }
}

export class FakeReverse implements ReversePort {
  readonly calls: Array<Parameters<ReversePort["reverse"]>[0]> = [];
  reverse(input: Parameters<ReversePort["reverse"]>[0]): Promise<void> {
    this.calls.push(input);
    return Promise.resolve();
  }
}

/** KV-shaped fake: a plain map from key to published HTML. */
export class FakePublishOg implements PublishOgPort {
  readonly calls: Array<Parameters<PublishOgPort["publishOg"]>[0]> = [];
  readonly store = new Map<string, string>();
  publishOg(input: Parameters<PublishOgPort["publishOg"]>[0]): Promise<void> {
    this.calls.push(input);
    this.store.set(input.key, input.html);
    return Promise.resolve();
  }
}

export class FakeCurrentMember implements CurrentMemberPort {
  readonly calls: string[] = [];
  private readonly members = new Map<string, CurrentMember>();

  register(clerkUserId: string, member: CurrentMember): void {
    this.members.set(clerkUserId, member);
  }

  currentMember(input: { clerkUserId: string }): Promise<CurrentMember | null> {
    this.calls.push(input.clerkUserId);
    return Promise.resolve(this.members.get(input.clerkUserId) ?? null);
  }
}
