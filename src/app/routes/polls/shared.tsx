import type { ReactNode } from "react";

import { EmptyState, StatusChip } from "../../components/ui";
import { useFeatureFlag } from "../../lib/flags";
import type { Poll } from "./api";

const dateFormat = new Intl.DateTimeFormat("sv-SE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Stockholm",
});

export const formatDate = (iso: string): string => dateFormat.format(new Date(iso));

/** Polls stay hidden until the integrator turns `FLAG_POLLS` on (fails closed). */
export function PollsGate({ children }: { readonly children: ReactNode }) {
  if (!useFeatureFlag("polls")) {
    return <EmptyState title="Polls aren't available yet">Check back soon.</EmptyState>;
  }
  return <>{children}</>;
}

export function PollStatus({ poll }: { readonly poll: Poll }) {
  if (poll.closed) return <StatusChip>Closed</StatusChip>;
  return (
    <StatusChip tone="success">
      {poll.closesAt ? `Open until ${formatDate(poll.closesAt)}` : "Open"}
    </StatusChip>
  );
}
