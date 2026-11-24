import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AuthProvider } from "./auth/AuthProvider";
import { AppRoot } from "./shell/AppRoot";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AuthProvider>
        <AppRoot />
      </AuthProvider>
    </StrictMode>,
  );
}
