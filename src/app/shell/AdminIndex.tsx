import { navigate } from "../lib/navigate";
import { adminIndex, type NavLink } from "./navigation";

/** Admin landing list. Rendered only for admins; the links come from the adminIndex registry. */
export function AdminIndex({
  isAdmin,
  items = adminIndex,
}: {
  readonly isAdmin: boolean;
  readonly items?: readonly NavLink[];
}) {
  if (!isAdmin) {
    return (
      <section className="bcq-state bcq-state--empty">
        <h1 className="bcq-state__title">Admins only</h1>
        <p className="bcq-state__body">You need admin access to see this page.</p>
      </section>
    );
  }

  return (
    <section className="bcq-page" aria-labelledby="admin-index-title">
      <h1 id="admin-index-title" className="bcq-page__title">
        Admin
      </h1>
      <ul className="bcq-menu">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={item.path}
              className="bcq-menu__item"
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                navigate(item.path);
              }}
            >
              <span>{item.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
