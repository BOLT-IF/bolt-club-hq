import type { ComponentType } from "react";

import type { EventDetail, EventViewer } from "../../api/events";

/** The four places on the event page that later stories fill (PLAN §12). */
export const SLOT_NAMES = ["RsvpSlot", "ShareSlot", "OrganizerToolsSlot", "AttendeesSlot"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export interface SlotProps {
  readonly event: EventDetail;
  readonly viewer: EventViewer;
}

const registry = new Map<SlotName, ComponentType<SlotProps>[]>();

/**
 * Fills a slot. A story calls this at module load from its own `routes.tsx`
 * (S4.2 → RsvpSlot, S7.1 → ShareSlot, S8.1 → OrganizerToolsSlot and AttendeesSlot).
 * Returns an unregister function.
 */
export function registerSlot(name: SlotName, component: ComponentType<SlotProps>): () => void {
  registry.set(name, [...(registry.get(name) ?? []), component]);
  return () => {
    registry.set(
      name,
      (registry.get(name) ?? []).filter((c) => c !== component),
    );
  };
}

/** For tests. */
export function clearSlots(): void {
  registry.clear();
}

/** Renders everything registered in the slot, in registration order. Empty slot: nothing. */
export function Slot({ name, event, viewer }: SlotProps & { readonly name: SlotName }) {
  return (
    <>
      {(registry.get(name) ?? []).map((Component, index) => (
        <Component key={index} event={event} viewer={viewer} />
      ))}
    </>
  );
}
