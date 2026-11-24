import { useCallback, useEffect, useState } from "react";

import { onStateChange, readFlag, setFlag } from "./state";
import type { PushPort } from "./pushPort";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Re-renders when a remembered flag changes (e.g. noteRsvpSaved from another component). */
export function useFlags() {
  const read = () => ({
    rsvped: readFlag("rsvped"),
    pushDeclined: readFlag("pushDeclined"),
    installDismissed: readFlag("installDismissed"),
  });
  const [flags, setFlags] = useState(read);
  useEffect(
    () =>
      onStateChange(() => {
        setFlags(read());
      }),
    [],
  );
  return flags;
}

/** Push permission plus an enable action. Asks only when `enable` is called from a tap. */
export function usePush(push: PushPort) {
  const [permission, setPermission] = useState(push.permission);
  const enable = useCallback(async () => {
    const answer = await push.request();
    setPermission(answer);
    if (answer === "granted") {
      await push.resubscribe();
    } else {
      setFlag("pushDeclined"); // never re-ask after a decline
    }
  }, [push]);
  return { permission, enable };
}

/** Chrome's deferred install prompt (Android/desktop). null until the browser offers it. */
export function useInstallEvent() {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const install = useCallback(async () => {
    if (!event) return;
    await event.prompt();
    const { outcome } = await event.userChoice;
    setEvent(null);
    if (outcome === "accepted") setInstalled(true);
  }, [event]);
  return { canInstall: event !== null, installed, install };
}
