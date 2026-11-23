import type { AppRoute } from "../registry";

// Probe route proving frontend auto-registration (S0.1). Remove once real routes exist.
function ProbeRoute() {
  return <p data-testid="probe-route">probe</p>;
}

const route: AppRoute = { path: "/probe", component: ProbeRoute };
export default route;
