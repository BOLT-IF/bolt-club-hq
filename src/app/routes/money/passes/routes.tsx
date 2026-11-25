import type { AppRoute } from "../../registry";
import { PassesPage } from "./PassesPage";

const routes: readonly AppRoute[] = [
  { path: "/money/passes", component: PassesPage },
  { path: "/passes", component: PassesPage },
];
export default routes;
