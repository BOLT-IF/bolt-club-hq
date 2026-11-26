import type { AppRoute } from "../../registry";
import { AdminBalances } from "./AdminBalances";
import { AdminClubFees } from "./AdminClubFees";
import { AdminMemberLedger } from "./AdminMemberLedger";

const routes: readonly AppRoute[] = [
  { path: "/admin/money", component: AdminBalances },
  { path: "/admin/money/club-fees", component: AdminClubFees },
  { path: "/admin/money/members/:id", component: AdminMemberLedger },
];
export default routes;
