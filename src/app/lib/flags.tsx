import { createContext, useContext, type ReactNode } from "react";

/** Per-area feature flags, served from /api/v1/config (PLAN §11.5). */
export type FeatureFlags = Readonly<Record<string, boolean>>;

const FeatureFlagsContext = createContext<FeatureFlags>({});
const FeatureFlagsLoadedContext = createContext<boolean>(true);

export function FeatureFlagsProvider({
  flags,
  loaded = true,
  children,
}: {
  readonly flags: FeatureFlags;
  readonly loaded?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <FeatureFlagsLoadedContext.Provider value={loaded}>
      <FeatureFlagsContext.Provider value={flags}>{children}</FeatureFlagsContext.Provider>
    </FeatureFlagsLoadedContext.Provider>
  );
}

export function useFeatureFlags(): FeatureFlags {
  return useContext(FeatureFlagsContext);
}

/** False only on cold first load before /api/v1/config or cached flags are ready. */
export function useFeatureFlagsLoaded(): boolean {
  return useContext(FeatureFlagsLoadedContext);
}

/** Fails closed: a missing or disabled flag reads as off. */
export function useFeatureFlag(name: string): boolean {
  return useFeatureFlags()[name] === true;
}
