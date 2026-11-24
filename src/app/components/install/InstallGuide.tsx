import { useState } from "react";

import { Button } from "../ui/Button";
import { useInstallEvent, usePush } from "./hooks";
import { detectInstallContext, type InstallContext } from "./platform";
import { browserPush, type PushPort } from "./pushPort";
import { AndroidSteps, IosSteps } from "./Steps";
import "./install.css";

export interface InstallGuideProps {
  readonly context?: InstallContext;
  readonly push?: PushPort;
}

/** The /install page (More → Install the app). Asking for push here is the member's own choice. */
export function InstallGuide({ context, push = browserPush }: InstallGuideProps) {
  const [ctx] = useState(() => context ?? detectInstallContext());
  const { permission, enable } = usePush(push);
  const installEvent = useInstallEvent();

  return (
    <section className="bcq-page" aria-labelledby="install-title">
      <h1 id="install-title" className="bcq-page__title">
        Install the app
      </h1>

      <section className="bcq-install" aria-labelledby="install-steps-title">
        <h2 id="install-steps-title" className="bcq-install__title">
          This device
        </h2>
        {ctx.standalone || installEvent.installed ? (
          <p className="bcq-install__body">You&apos;re using the installed app. Nothing to do.</p>
        ) : ctx.platform === "ios" ? (
          <>
            <p className="bcq-install__body">
              On iPhone and iPad, notifications need iOS 16.4 or later and the app on your home
              screen.
            </p>
            <IosSteps />
          </>
        ) : installEvent.canInstall ? (
          <Button
            onClick={() => {
              void installEvent.install();
            }}
          >
            Install
          </Button>
        ) : ctx.platform === "android" ? (
          <AndroidSteps />
        ) : (
          <p className="bcq-install__body">
            Use your browser&apos;s install icon in the address bar, or keep using it in a tab.
          </p>
        )}
      </section>

      <section className="bcq-install" aria-labelledby="install-push-title">
        <h2 id="install-push-title" className="bcq-install__title">
          Notifications
        </h2>
        {permission === "granted" ? (
          <p className="bcq-install__body" role="status">
            Notifications are on for this device.
          </p>
        ) : permission === "denied" ? (
          <p className="bcq-install__body">
            Notifications are blocked. Allow them for this site in your browser or phone settings.
          </p>
        ) : permission === null ? (
          <p className="bcq-install__body">
            This browser can&apos;t show notifications. Install the app first. Your inbox always has
            every message.
          </p>
        ) : (
          <Button
            onClick={() => {
              void enable();
            }}
          >
            Turn on notifications
          </Button>
        )}
      </section>
    </section>
  );
}
