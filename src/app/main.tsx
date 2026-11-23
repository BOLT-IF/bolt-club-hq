import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppRoot } from "./shell/AppRoot";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AppRoot />
    </StrictMode>,
  );
}
