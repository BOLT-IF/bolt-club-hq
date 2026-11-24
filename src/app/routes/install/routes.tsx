import { InstallGuide } from "../../components/install";
import type { AppRoute } from "../registry";

const route: AppRoute = { path: "/install", component: () => <InstallGuide /> };
export default route;
