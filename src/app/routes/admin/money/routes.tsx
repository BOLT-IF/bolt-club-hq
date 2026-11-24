import type { AppRoute } from "../../registry";
import { AdminBalances } from "./AdminBalances";
import { AdminMemberLedger } from "./AdminMemberLedger";

const routes: readonly AppRoute[] = [
  { path: "/admin/money", component: AdminBalances },
  { path: "/admin/money/members/:id", component: AdminMemberLedger },
];
export default routes;
