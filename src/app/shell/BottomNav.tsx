import type { MouseEvent } from "react";

import { useFeatureFlags } from "../lib/flags";
import { cx } from "../lib/cx";
import { isActivePath, navigate } from "../lib/navigate";
import { NavIcon } from "./icons";
import { visibleNavItems, type NavItem } from "./navigation";

export interface BottomNavProps {
  readonly items: readonly NavItem[];
  /** Current pathname, used for aria-current. */
  readonly path: string;
  /** Badge counts keyed by NavItem.badge, for example { inbox: 3 }. */
  readonly badges: Readonly<Record<string, number>>;
  readonly onMore: () => void;
  readonly isAdmin?: boolean;
}

/**
 * Primary navigation: Home · Events · Money · Inbox · More. Items hidden by a
 * disabled feature flag are not rendered at all.
 */
export function BottomNav({ items, path, badges, onMore, isAdmin = false }: BottomNavProps) {
  const flags = useFeatureFlags();
  const visible = visibleNavItems(items, flags, isAdmin);

  return (
    <nav className="bcq-tabbar" aria-label="Primary">
      <ul className="bcq-tabbar__list">
        {visible.map((item) => {
          const count = item.badge === undefined ? 0 : (badges[item.badge] ?? 0);
          const content = (
            <>
              <span className="bcq-tabbar__icon">
                {item.icon ? <NavIcon name={item.icon} /> : null}
                {count > 0 ? (
                  <span className="bcq-tabbar__badge" aria-hidden="true">
                    {count > 99 ? "99+" : String(count)}
                  </span>
                ) : null}
              </span>
              <span className="bcq-tabbar__label">{item.label}</span>
              {count > 0 ? (
                <span className="bcq-visually-hidden"> {String(count)} unread</span>
              ) : null}
            </>
          );

          if ("action" in item) {
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="bcq-tabbar__item"
                  aria-haspopup="dialog"
                  onClick={onMore}
                >
                  {content}
                </button>
              </li>
            );
          }

          const active = isActivePath(path, item.path);
          return (
            <li key={item.id}>
              <a
                href={item.path}
                className={cx("bcq-tabbar__item", active && "is-active")}
                aria-current={active ? "page" : undefined}
                onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                  event.preventDefault();
                  navigate(item.path);
                }}
              >
                {content}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
