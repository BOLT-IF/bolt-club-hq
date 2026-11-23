/// <reference lib="webworker" />
/**
 * Service worker (vite-plugin-pwa injectManifest, S0.3).
 *
 * - Precaches the app shell from the injected manifest.
 * - Navigations get the cached shell, except under the denylist (/api, /e, /s, /media).
 * - Allowlisted GET API routes are network-first with a 3 s timeout, then cache, and the
 *   page is told when it is serving stale data.
 * - Logout clears every app cache (CLEAR_APP_CACHES).
 * - A new worker waits until the user accepts the update prompt (SKIP_WAITING).
 */
import { MSG, type ClientMessage, type WorkerMessage } from "./messages";
import {
  API_CACHE,
  NETWORK_TIMEOUT_MS,
  SHELL_CACHE,
  isAppCacheName,
  isNavigationFallbackAllowed,
  isNetworkFirstRoute,
} from "./routes";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

/**
 * The shell is served at "/". Requesting /index.html gets a 307 from the assets binding
 * (single-page-application handling), and cache.addAll() rejects redirects, so the shell
 * is precached under "/" and /index.html itself is never precached.
 */
const SHELL_URL = "/";

function precacheUrls(): string[] {
  const urls = self.__WB_MANIFEST.map((entry) => (typeof entry === "string" ? entry : entry.url));
  return [...new Set(urls)].filter((url) => url !== "index.html").map((url) => `/${url}`);
}

const precachedPaths = new Set(precacheUrls());

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      await cache.addAll([...precacheUrls(), SHELL_URL]);
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      // Drop caches from older app versions; keep the current ones.
      await Promise.all(
        names
          .filter((name) => isAppCacheName(name) && name !== SHELL_CACHE && name !== API_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as ClientMessage | undefined;
  if (data?.type === MSG.SKIP_WAITING) {
    void self.skipWaiting();
    return;
  }
  if (data?.type === MSG.CLEAR_APP_CACHES) {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(isAppCacheName).map((name) => caches.delete(name)));
        event.ports[0]?.postMessage({ cleared: true });
      })(),
    );
  }
});

async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (response.ok) {
      void cache.put(request, response.clone());
    }
    await notifyClients({ type: MSG.FRESH });
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      await notifyClients({ type: MSG.STALE });
      return cached;
    }
    return Response.error();
  }
}

function fetchWithTimeout(request: Request, ms: number): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("network timeout"));
    }, ms);
    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("network error"));
      },
    );
  });
}

async function notifyClients(message: WorkerMessage): Promise<void> {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage(message);
  }
}

async function appShell(): Promise<Response> {
  const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
  return cached ?? fetch(SHELL_URL);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    if (!isNavigationFallbackAllowed(url.pathname)) {
      return; // Let the browser handle it: the Worker answers /api, /e, /s and /media.
    }
    event.respondWith(appShell().catch(() => fetch(request)));
    return;
  }

  if (isNetworkFirstRoute(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Precached static assets (JS, CSS, icons, manifest) are served cache-first, so the shell
  // still renders offline. Anything else is left to the network.
  if (isPrecachedAsset(url.pathname)) {
    event.respondWith(
      caches.match(request, { cacheName: SHELL_CACHE }).then((cached) => cached ?? fetch(request)),
    );
  }
});

function isPrecachedAsset(pathname: string): boolean {
  return precachedPaths.has(pathname);
}
