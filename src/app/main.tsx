import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { registeredFrontendRoutes } from "./routes/registry";

function App() {
  const path = window.location.pathname;
  const route = registeredFrontendRoutes().find((r) => r.path === path);
  const Page = route?.component;
  return <div data-testid="app-shell">{Page ? <Page /> : <p>Not found</p>}</div>;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
