import type { AppRoute } from "../registry";
import { SignInPage } from "./SignInPage";
import { SignOutPage } from "./SignOutPage";

const routes: AppRoute[] = [
  { path: "/sign-in", component: SignInPage },
  { path: "/sign-out", component: SignOutPage },
];
export default routes;
