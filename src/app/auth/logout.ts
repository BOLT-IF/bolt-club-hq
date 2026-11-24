export interface LogoutSteps {
  readonly signOut: () => Promise<void>;
  /** Clears the service-worker caches (src/sw/client.ts clearAppCaches). */
  readonly clearCaches: () => Promise<void>;
  readonly navigate: (path: string) => void;
}

/**
 * Sign out, then clear the service-worker caches, so the next person on a shared phone
 * never sees cached member data. Caches are cleared even if sign-out fails (offline);
 * the failure is then re-thrown so the caller can say so.
 */
export async function logout(steps: LogoutSteps): Promise<void> {
  try {
    await steps.signOut();
  } finally {
    await steps.clearCaches();
  }
  steps.navigate("/");
}
