import type { AppRoute } from "../../../registry";
import { SchedulePage } from "./SchedulePage";

const route: AppRoute = { path: "/admin/terms/series/:id/schedule", component: SchedulePage };
export default route;
