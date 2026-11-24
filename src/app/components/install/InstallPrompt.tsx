import { useEffect, useState } from "react";

import { Button } from "../ui/Button";
import { useFlags, useInstallEvent, usePush } from "./hooks";
import { decidePrompt, detectInstallContext, type InstallContext } from "./platform";
import { browserPush, type PushPort } from "./pushPort";
import { setFlag } from "./state";
import { AndroidSteps, IosSteps } from "./Steps";
import "./install.css";

export interface InstallPromptProps {
  readonly context?: InstallContext;
  readonly push?: PushPort;
}

/**
 * Install / push card mounted in the shell (S10.2). Install card on mobile browsers; push card
 * only after the first RSVP, and permission is requested only when the member taps. A Not now
 * or a declined browser prompt is remembered and never re-asked. Also re-subscribes on every
 * open when permission is already granted (PLAN §10).
 */
export function InstallPrompt({ context, push = browserPush }: InstallPromptProps) {
  const [ctx] = useState(() => context ?? detectInstallContext());
  const flags = useFlags();
  const { permission, enable } = usePush(push);
  const installEvent = useInstallEvent();
  const [justEnabled, setJustEnabled] = useState(false);

  useEffect(() => {
    if (push.permission() === "granted") void push.resubscribe();
  }, [push]);

  if (justEnabled) {
    return (
      <p className="bcq-install bcq-install--done" role="status">
        Notifications are on.
      </p>
    );
  }

  const kind = installEvent.installed
    ? null
    : decidePrompt(ctx, { ...flags, pushPermission: permission });
  if (kind === null) return null;

  if (kind === "push") {
    return (
      <section className="bcq-install" aria-labelledby="bcq-push-title">
        <h2 id="bcq-push-title" className="bcq-install__title">
          Get notified about your sessions
        </h2>
        <p className="bcq-install__body">
          Hear when you move off the waitlist, an event changes or a payment is due.
        </p>
        <div className="bcq-install__actions">
          <Button
            onClick={() => {
              void enable().then(() => {
                if (push.permission() === "granted") setJustEnabled(true);
              });
            }}
          >
            Turn on notifications
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setFlag("pushDeclined");
            }}
          >
            Not now
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="bcq-install" aria-labelledby="bcq-install-title">
      <h2 id="bcq-install-title" className="bcq-install__title">
        Add Bolt Club to your home screen
      </h2>
      <p className="bcq-install__body">
        It opens like an app{kind === "install-ios" ? " and can send you notifications" : ""}.
      </p>
      {kind === "install-ios" ? <IosSteps /> : installEvent.canInstall ? null : <AndroidSteps />}
      <div className="bcq-install__actions">
        {kind === "install-android" && installEvent.canInstall ? (
          <Button
            onClick={() => {
              void installEvent.install();
            }}
          >
            Install
          </Button>
        ) : null}
        <Button
          variant="ghost"
          onClick={() => {
            setFlag("installDismissed");
          }}
        >
          Not now
        </Button>
      </div>
    </section>
  );
}
