import { detectInstallContext } from "../components/install/platform";
import { useFeatureFlags } from "../lib/flags";
import { navigate } from "../lib/navigate";
import { BottomSheet } from "../components/ui/BottomSheet";
import { NavIcon } from "./icons";
import { moreMenu, visibleNavItems } from "./navigation";

export function MoreSheet({
  open,
  isAdmin,
  isSignedIn = false,
  onClose,
}: {
  readonly open: boolean;
  readonly isAdmin: boolean;
  readonly isSignedIn?: boolean;
  readonly onClose: () => void;
}) {
  const flags = useFeatureFlags();
  const { standalone } = detectInstallContext();
  const items = visibleNavItems(moreMenu, flags, isAdmin, { standalone, isSignedIn });

  return (
    <BottomSheet open={open} title="More" onClose={onClose}>
      <ul className="bcq-menu">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={item.path}
              className="bcq-menu__item"
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                onClose();
                navigate(item.path);
              }}
            >
              {item.icon ? <NavIcon name={item.icon} /> : null}
              <span>{item.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </BottomSheet>
  );
}
