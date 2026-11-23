/**
 * Page-side service worker glue (S0.3). Imported from the app entry; no React.
 *
 * - registerServiceWorker(): registers /sw.js and surfaces update prompts.
 * - clearAppCaches(): exported logout hook. Call it when the user signs out.
 * - The stale badge is shown while an allowlisted API response came from cache.
 */
import { MSG, type ClientMessage, type WorkerMessage } from "./messages";

const PROMPT_TEST_ID = "update-prompt";
const BADGE_TEST_ID = "stale-badge";
const APP_CACHE_PREFIX = "bolt-club-hq-";

/**
 * Deletes every cache this app created. Resolves once the worker confirms the purge.
 * Without a controlling worker, the page clears the caches itself.
 */
export async function clearAppCaches(): Promise<void> {
  const controller = navigator.serviceWorker.controller;
  if (controller) {
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        resolve();
      };
      const message: ClientMessage = { type: MSG.CLEAR_APP_CACHES };
      controller.postMessage(message, [channel.port2]);
    });
    return;
  }
  const names = await caches.keys();
  await Promise.all(
    names.filter((name) => name.startsWith(APP_CACHE_PREFIX)).map((name) => caches.delete(name)),
  );
}

function showUpdatePrompt(registration: ServiceWorkerRegistration): void {
  if (document.querySelector(`[data-testid="${PROMPT_TEST_ID}"]`)) {
    return;
  }
  const bar = document.createElement("div");
  bar.setAttribute("data-testid", PROMPT_TEST_ID);
  bar.setAttribute("role", "status");
  bar.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;padding:12px 16px;background:#003087;color:#fff;display:flex;gap:12px;align-items:center;justify-content:space-between;font:14px system-ui,sans-serif;z-index:2147483647";

  const text = document.createElement("span");
  text.textContent = "A new version is available.";

  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.style.cssText =
    "padding:8px 12px;border:0;border-radius:6px;background:#fff;color:#003087;font-weight:600";
  reload.addEventListener("click", () => {
    const waiting = registration.waiting;
    if (!waiting) {
      window.location.reload();
      return;
    }
    // The page reloads once the new worker takes control (see controllerchange below).
    const message: ClientMessage = { type: MSG.SKIP_WAITING };
    waiting.postMessage(message);
  });

  bar.append(text, reload);
  document.body.append(bar);
}

function showStaleBadge(): void {
  if (document.querySelector(`[data-testid="${BADGE_TEST_ID}"]`)) {
    return;
  }
  const badge = document.createElement("span");
  badge.setAttribute("data-testid", BADGE_TEST_ID);
  badge.textContent = "Offline: showing saved data";
  badge.style.cssText =
    "position:fixed;top:8px;right:8px;padding:4px 8px;border-radius:999px;background:#ffc439;color:#111;font:12px system-ui,sans-serif;z-index:2147483647";
  document.body.append(badge);
}

function hideStaleBadge(): void {
  document.querySelector(`[data-testid="${BADGE_TEST_ID}"]`)?.remove();
}

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) {
    return;
  }

  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
    if (event.data.type === MSG.STALE) {
      showStaleBadge();
    } else {
      hideStaleBadge();
    }
  });

  // Reload once the new worker has taken over after the user accepted the prompt.
  let updateAvailable = false;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!reloading && updateAvailable) {
      reloading = true;
      window.location.reload();
    }
  });

  // Module scripts run after parsing and may execute after `load` has already fired,
  // so register now if the document is complete, otherwise wait for it.
  const start = (): void => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((registration) => {
      const announce = (): void => {
        updateAvailable = true;
        showUpdatePrompt(registration);
      };
      if (registration.waiting && navigator.serviceWorker.controller) {
        announce();
      }
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) {
          return;
        }
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            announce();
          }
        });
      });
    });
  };

  if (document.readyState === "complete") {
    start();
  } else {
    window.addEventListener("load", start);
  }
}
