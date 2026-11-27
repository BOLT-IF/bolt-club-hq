import { useEffect, useState, type ReactNode } from "react";

import { apiFetch } from "../api/client";
import { navigate } from "../lib/navigate";
import { listPolls } from "../routes/polls/api";
import { adminIndex, type NavLink } from "./navigation";

interface AdminCounts {
  readonly members: number | null;
  readonly pendingRequests: number | null;
  readonly activePolls: number | null;
}

const SECTIONS: ReadonlyArray<{
  readonly title: string;
  readonly ids: readonly string[];
}> = [
  { title: "PEOPLE", ids: ["admin-members", "admin-approvals"] },
  { title: "OPERATIONS", ids: ["admin-terms", "admin-money"] },
  { title: "COMMUNICATION", ids: ["admin-reminders", "admin-broadcast", "admin-polls"] },
  { title: "SYSTEM", ids: ["admin-settings", "admin-audit"] },
];

const PRIMARY_OPERATIONS = new Set(["admin-terms", "admin-money"]);

function ChevronRightIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function sectionIcon(id: string): ReactNode {
  const props = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  switch (id) {
    case "admin-members":
      return (
        <svg {...props}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "admin-approvals":
      return (
        <svg {...props}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <line x1="19" y1="8" x2="19" y2="14" />
          <line x1="22" y1="11" x2="16" y2="11" />
        </svg>
      );
    case "admin-terms":
      return (
        <svg {...props}>
          <rect width="18" height="18" x="3" y="4" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      );
    case "admin-money":
      return (
        <svg {...props}>
          <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
          <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
        </svg>
      );
    case "admin-reminders":
      return (
        <svg {...props}>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      );
    case "admin-broadcast":
      return (
        <svg {...props}>
          <path d="m3 11 18-5v12L3 14v-3z" />
          <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
        </svg>
      );
    case "admin-polls":
      return (
        <svg {...props}>
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      );
    case "admin-settings":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <path d="M12 11h4" />
          <path d="M12 16h4" />
          <path d="M8 11h.01" />
          <path d="M8 16h.01" />
        </svg>
      );
  }
}

function renderBadge(id: string, counts: AdminCounts): ReactNode {
  if (id === "admin-members" && counts.members && counts.members > 0) {
    return <span className="bcq-admin-row__count">{counts.members}</span>;
  }
  if (id === "admin-approvals" && counts.pendingRequests && counts.pendingRequests > 0) {
    return (
      <span className="bcq-admin-row__pill bcq-admin-row__pill--amber">
        {counts.pendingRequests}
      </span>
    );
  }
  if (id === "admin-polls" && counts.activePolls && counts.activePolls > 0) {
    return (
      <span className="bcq-admin-row__pill bcq-admin-row__pill--emerald">
        {counts.activePolls} Active
      </span>
    );
  }
  return null;
}

/** Admin landing hub with grouped inset lists, leading icons, and glanceable counts. */
export function AdminIndex({
  isAdmin,
  items = adminIndex,
}: {
  readonly isAdmin: boolean;
  readonly items?: readonly NavLink[];
}) {
  const [counts, setCounts] = useState<AdminCounts>({
    members: null,
    pendingRequests: null,
    activePolls: null,
  });

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    void Promise.allSettled([
      apiFetch<{ members: Array<{ status: string }> }>("/admin/members"),
      apiFetch<{ requests: unknown[] }>("/admin/join-requests"),
      listPolls(),
    ]).then(([membersRes, reqsRes, pollsRes]) => {
      if (isCancelled()) return;
      const members =
        membersRes.status === "fulfilled" && Array.isArray(membersRes.value.members)
          ? membersRes.value.members.filter((m) => m.status !== "erased").length
          : null;
      const pendingRequests =
        reqsRes.status === "fulfilled" && Array.isArray(reqsRes.value.requests)
          ? reqsRes.value.requests.length
          : null;
      const activePolls =
        pollsRes.status === "fulfilled" && Array.isArray(pollsRes.value)
          ? pollsRes.value.filter((p) => !p.closed).length
          : null;
      setCounts({ members, pendingRequests, activePolls });
    });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <section className="bcq-state bcq-state--empty">
        <h1 className="bcq-state__title">Admins Only</h1>
        <p className="bcq-state__body">You need admin access to see this page.</p>
      </section>
    );
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const knownIds = new Set(SECTIONS.flatMap((s) => s.ids));
  const extra = items.filter((i) => !knownIds.has(i.id));

  return (
    <section className="bcq-page bcq-admin-hub" aria-labelledby="admin-index-title">
      <h1 id="admin-index-title" className="bcq-page__title">
        Admin
      </h1>

      <div className="bcq-admin-groups">
        {SECTIONS.map((section) => {
          const sectionItems = section.ids
            .map((id) => byId.get(id))
            .filter((item): item is NavLink => item !== undefined);
          if (sectionItems.length === 0) return null;
          return (
            <div key={section.title} className="bcq-admin-group">
              <h2 className="bcq-admin-group__title">{section.title}</h2>
              <ul className="bcq-admin-group__card">
                {sectionItems.map((item) => (
                  <li key={item.id} className="bcq-admin-group__item">
                    <a
                      href={item.path}
                      className="bcq-admin-row"
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                          return;
                        event.preventDefault();
                        navigate(item.path);
                      }}
                    >
                      <span
                        className={
                          PRIMARY_OPERATIONS.has(item.id)
                            ? "bcq-admin-row__icon bcq-admin-row__icon--amber"
                            : "bcq-admin-row__icon"
                        }
                      >
                        {sectionIcon(item.id)}
                      </span>
                      <span className="bcq-admin-row__label">{item.label}</span>
                      <span className="bcq-admin-row__trailing">
                        {renderBadge(item.id, counts)}
                        <span className="bcq-admin-row__chevron">
                          <ChevronRightIcon />
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}

        {extra.length > 0 ? (
          <div className="bcq-admin-group">
            <h2 className="bcq-admin-group__title">OTHER</h2>
            <ul className="bcq-admin-group__card">
              {extra.map((item) => (
                <li key={item.id} className="bcq-admin-group__item">
                  <a
                    href={item.path}
                    className="bcq-admin-row"
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                        return;
                      event.preventDefault();
                      navigate(item.path);
                    }}
                  >
                    <span className="bcq-admin-row__icon">{sectionIcon(item.id)}</span>
                    <span className="bcq-admin-row__label">{item.label}</span>
                    <span className="bcq-admin-row__trailing">
                      <span className="bcq-admin-row__chevron">
                        <ChevronRightIcon />
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
