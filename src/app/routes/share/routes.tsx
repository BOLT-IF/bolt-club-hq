import type { AppRoute } from "../registry";
import { ShareEventPage, ShareSeriesPage } from "./SharePage";

const routes: AppRoute[] = [
  { path: "/e/:slug", component: ShareEventPage },
  { path: "/s/:slug", component: ShareSeriesPage },
];

export default routes;
