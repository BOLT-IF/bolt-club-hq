import "../../components/organizer/attendance-register";
import "../../components/rsvp/register";
import type { AppRoute } from "../registry";
import { EventDetailPage } from "./EventDetailPage";
import { EventListPage } from "./EventListPage";

const routes: AppRoute[] = [
  { path: "/events", component: EventListPage },
  { path: "/events/:slug", component: EventDetailPage },
];
export default routes;
