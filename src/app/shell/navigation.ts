import type { FeatureFlags } from "../lib/flags";

/** Registry of navigation targets. Feature areas add entries here, nothing else is wired by hand. */

export type NavIconName =
  | "home"
  | "events"
  | "money"
  | "inbox"
  | "more"
  | "profile"
  | "bell"
  | "history"
  | "shield"
  | "download"
  | "admin"
  | "logout";

interface NavBase {
  readonly id: string;
  readonly label: string;
  readonly icon?: NavIconName;
  /** Hidden unless this feature flag is on (fail closed). */
  readonly flag?: string;
  /** Hidden unless the signed-in member is an admin. */
  readonly requiresAdmin?: boolean;
  /** Hidden unless the viewer is signed in. */
  readonly requiresSignedIn?: boolean;
  /** Hidden when already running as an installed PWA (standalone). */
  readonly hideInStandalone?: boolean;
  /** Key into the badge counts passed to the shell, for example "inbox". */
  readonly badge?: string;
}

export interface NavLink extends NavBase {
  readonly path: string;
}

/** Opens the More sheet instead of navigating. */
export interface NavAction extends NavBase {
  readonly action: "more";
}

export type NavItem = NavLink | NavAction;

export const PRIMARY_NAV: readonly NavItem[] = [
  { id: "home", label: "Home", path: "/", icon: "home" },
  { id: "events", label: "Events", path: "/events", icon: "events", flag: "events" },
  { id: "money", label: "Money", path: "/money", icon: "money", flag: "money" },
  { id: "inbox", label: "Inbox", path: "/inbox", icon: "inbox", flag: "inbox", badge: "inbox" },
  { id: "more", label: "More", action: "more", icon: "more" },
];

export const moreMenu: readonly NavLink[] = [
  { id: "profile", label: "Profile", path: "/profile", icon: "profile" },
  { id: "notifications", label: "Notifications", path: "/settings/notifications", icon: "bell" },
  { id: "attendance-history", label: "Attendance History", path: "/history", icon: "history" },
  { id: "privacy", label: "Privacy", path: "/privacy", icon: "shield", flag: "privacy" },
  {
    id: "install",
    label: "Install the App",
    path: "/install",
    icon: "download",
    hideInStandalone: true,
  },
  { id: "admin", label: "Admin", path: "/admin", icon: "admin", requiresAdmin: true },
  {
    id: "sign-out",
    label: "Sign Out",
    path: "/sign-out",
    icon: "logout",
    requiresSignedIn: true,
  },
];

/** Sections listed on the Admin index. Every entry is admin-only. */
export const adminIndex: readonly NavLink[] = [
  { id: "admin-members", label: "Members", path: "/admin/members", requiresAdmin: true },
  {
    id: "admin-approvals",
    label: "Invites & Join Requests",
    path: "/admin/approvals",
    requiresAdmin: true,
  },
  { id: "admin-terms", label: "Terms & Series", path: "/admin/terms", requiresAdmin: true },
  { id: "admin-money", label: "Club Finances", path: "/admin/money", requiresAdmin: true },
  { id: "admin-reminders", label: "Reminders", path: "/admin/reminders", requiresAdmin: true },
  { id: "admin-broadcast", label: "Broadcast", path: "/admin/broadcast", requiresAdmin: true },
  { id: "admin-polls", label: "Polls", path: "/admin/polls", requiresAdmin: true },
  { id: "admin-settings", label: "Settings", path: "/admin/settings", requiresAdmin: true },
  { id: "admin-audit", label: "Audit Log", path: "/admin/audit", requiresAdmin: true },
];

export interface VisibleNavOptions {
  readonly standalone?: boolean;
  readonly isSignedIn?: boolean;
}

/** Keeps items whose flag is on (or unset) and whose admin/auth/install rules pass. */
export function visibleNavItems<T extends NavItem>(
  items: readonly T[],
  flags: FeatureFlags,
  isAdmin = false,
  options: VisibleNavOptions = {},
): T[] {
  return items.filter(
    (item) =>
      (item.flag === undefined || flags[item.flag] === true) &&
      (item.requiresAdmin !== true || isAdmin) &&
      (item.requiresSignedIn !== true || options.isSignedIn === true) &&
      (item.hideInStandalone !== true || options.standalone !== true),
  );
}
