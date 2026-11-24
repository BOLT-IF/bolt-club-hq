import type { AppRoute } from "../registry";
import { JoinPage } from "./JoinPage";

const routes: readonly AppRoute[] = [
  { path: "/join", component: JoinPage },
  { path: "/join/:token", component: JoinPage },
  { path: "/join/event/:slug", component: JoinPage },
  { path: "/join/series/:slug", component: JoinPage },
];
export default routes;
