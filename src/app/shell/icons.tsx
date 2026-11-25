import type { NavIconName } from "./navigation";

/** Inline outline icons (24px grid). Decorative; labels carry the meaning. */
const PATHS: Record<NavIconName, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  events:
    "M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  money: "M3 7h18v12H3zM3 11h18M16 15h2",
  inbox:
    "M4 13l2.5-7.5A1 1 0 0 1 7.5 5h9a1 1 0 0 1 1 .5L20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 13h4l1 2h6l1-2h4",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4",
  history: "M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4M12 8v4l3 2",
  shield: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z",
  download: "M12 4v11M7 10l5 5 5-5M4 20h16",
  admin: "M12 3l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4",
};

export function NavIcon({ name }: { readonly name: NavIconName }) {
  return (
    <svg className="bcq-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d={PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
