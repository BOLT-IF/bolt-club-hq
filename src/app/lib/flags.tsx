import { createContext, useContext, type ReactNode } from "react";

/** Per-area feature flags, served from /api/v1/config (PLAN §11.5). */
export type FeatureFlags = Readonly<Record<string, boolean>>;

const FeatureFlagsContext = createContext<FeatureFlags>({});

export function FeatureFlagsProvider({
  flags,
  children,
}: {
  readonly flags: FeatureFlags;
  readonly children: ReactNode;
}) {
  return <FeatureFlagsContext.Provider value={flags}>{children}</FeatureFlagsContext.Provider>;
}

export function useFeatureFlags(): FeatureFlags {
  return useContext(FeatureFlagsContext);
}

/** Fails closed: a missing or disabled flag reads as off. */
export function useFeatureFlag(name: string): boolean {
  return useFeatureFlags()[name] === true;
}
