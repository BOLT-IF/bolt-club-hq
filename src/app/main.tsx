import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AuthProvider } from "./auth/AuthProvider";
import { AppErrorBoundary } from "./ops/ErrorBoundary";
import { createBrowserReporter } from "./ops/sentry";
import { AppRoot } from "./shell/AppRoot";

const reporter = createBrowserReporter({
  dsn: import.meta.env.VITE_SENTRY_DSN as string | undefined,
  environment: import.meta.env.MODE,
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AppErrorBoundary reporter={reporter}>
        <AuthProvider>
          <AppRoot />
        </AuthProvider>
      </AppErrorBoundary>
    </StrictMode>,
  );
}
