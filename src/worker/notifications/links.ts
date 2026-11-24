/** PLAN §10 categories. `admin_tasks` is for admins only. */
export const CATEGORIES = [
  "rsvp_status",
  "event_changes",
  "new_events",
  "payment_due",
  "payment_status",
  "polls",
  "announcements",
  "admin_tasks",
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

const DEFAULT_LINK: Record<Category, string> = {
  rsvp_status: "/events",
  event_changes: "/events",
  new_events: "/events",
  payment_due: "/money",
  payment_status: "/money",
  polls: "/inbox",
  announcements: "/inbox",
  admin_tasks: "/admin",
};

/**
 * The in-app path a notification opens. A given link is kept only when it is an
 * in-app path ("/events/x"); anything else (absolute URL, "//host", "/\host",
 * "javascript:") falls back to the category's screen, so a push can never point off-site.
 */
export function resolveLink(category: Category, link: string | undefined): string {
  if (link !== undefined && /^\/(?![/\\])/.test(link)) return link;
  return DEFAULT_LINK[category];
}
