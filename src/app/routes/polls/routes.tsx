import type { AppRoute } from "../registry";
import { AdminPollsPage } from "./AdminPollsPage";
import { PollDetailPage } from "./PollDetailPage";
import { PollListPage } from "./PollListPage";

// /admin/polls lives here (not in routes/admin/) because S9.1 Owns src/app/routes/polls/.
const routes: AppRoute[] = [
  { path: "/polls", component: PollListPage },
  { path: "/polls/:id", component: PollDetailPage },
  { path: "/admin/polls", component: AdminPollsPage },
];
export default routes;
