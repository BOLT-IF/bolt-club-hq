import type { AppRoute } from "../../registry";
import { SeriesPage } from "./SeriesPage";
import { TermPage } from "./TermPage";
import { TermsPage } from "./TermsPage";

const routes: AppRoute[] = [
  { path: "/admin/terms", component: TermsPage },
  { path: "/admin/terms/:id", component: TermPage },
  { path: "/admin/terms/series/:id", component: SeriesPage },
];
export default routes;
