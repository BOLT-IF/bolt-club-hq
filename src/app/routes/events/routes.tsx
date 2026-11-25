import "../../components/organizer/attendance-register";
import "../../components/organizer/edit-register";
import "../../components/organizer/roster-link-register";
import "../../components/rsvp/register";
import "../../components/rsvp/postclose";
import "../../components/rsvp/claim";
import "../../components/rsvp/claim-capacity";
import type { AppRoute } from "../registry";
import { EventDetailPage } from "./EventDetailPage";
import { EventListPage } from "./EventListPage";

const routes: AppRoute[] = [
  { path: "/events", component: EventListPage },
  { path: "/events/:slug", component: EventDetailPage },
];
export default routes;
