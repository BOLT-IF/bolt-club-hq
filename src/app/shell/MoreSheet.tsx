import { detectInstallContext } from "../components/install/platform";
import { BottomSheet } from "../components/ui/BottomSheet";
import { GroupedList } from "../components/ui/GroupedList";
import { useFeatureFlags } from "../lib/flags";
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
  const mainItems = items.filter((item) => item.id !== "sign-out");
  const signOutItem = items.find((item) => item.id === "sign-out");

  return (
    <BottomSheet open={open} title="More" onClose={onClose}>
      <div className="bcq-more-groups">
        <GroupedList.Section>
          {mainItems.map((item) => (
            <GroupedList.Row
              key={item.id}
              href={item.path}
              label={item.label}
              icon={item.icon ? <NavIcon name={item.icon} /> : undefined}
              iconTone={item.id === "admin" ? "amber" : "neutral"}
              onClick={onClose}
            />
          ))}
        </GroupedList.Section>
        {signOutItem ? (
          <GroupedList.Section>
            <GroupedList.Row
              href={signOutItem.path}
              label={signOutItem.label}
              icon={signOutItem.icon ? <NavIcon name={signOutItem.icon} /> : undefined}
              iconTone="danger"
              chevron={false}
              danger
              onClick={onClose}
            />
          </GroupedList.Section>
        ) : null}
      </div>
    </BottomSheet>
  );
}
