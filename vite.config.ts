import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Apple meta tags for the installed iOS app (S0.3), plus the page-side service worker
 * registration. The app entry (src/app/main.tsx) is outside S0.3's Owns list, so the
 * registration module is injected here instead.
 */
const REGISTER_ENTRY = "src/sw/register.ts";

function pwaHead(): Plugin {
  return {
    name: "bolt-club-hq:pwa-head",
    // Register the page-side SW glue as its own bundle entry, so it is compiled and
    // hashed like app code. index.html itself stays untouched.
    config() {
      return {
        build: {
          rolldownOptions: {
            input: { index: "index.html", register: REGISTER_ENTRY },
          },
        },
      };
    },
    transformIndexHtml(_html, ctx) {
      const registerChunk = Object.values(ctx.bundle ?? {}).find(
        (file) => file.type === "chunk" && file.facadeModuleId?.endsWith(`/${REGISTER_ENTRY}`),
      );
      const registerSrc = registerChunk ? `/${registerChunk.fileName}` : `/${REGISTER_ENTRY}`;
      return [
        {
          tag: "link",
          attrs: { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
          injectTo: "head",
        },
        {
          tag: "meta",
          attrs: { name: "apple-mobile-web-app-capable", content: "yes" },
          injectTo: "head",
        },
        {
          tag: "meta",
          attrs: { name: "apple-mobile-web-app-status-bar-style", content: "default" },
          injectTo: "head",
        },
        {
          tag: "meta",
          attrs: { name: "apple-mobile-web-app-title", content: "Bolt Club" },
          injectTo: "head",
        },
        { tag: "meta", attrs: { name: "theme-color", content: "#272e38" }, injectTo: "head" },
        { tag: "script", attrs: { type: "module", src: registerSrc }, injectTo: "body" },
      ];
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    // The Worker (src/worker/index.ts) serves /healthz and /api; everything else
    // is static assets from the same origin.
    cloudflare(),
    // S0.3: injectManifest. The service worker is src/sw/sw.ts; the plugin injects the
    // precache list into it and emits the web app manifest and dist/client/sw.js.
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/sw",
      filename: "sw.ts",
      injectRegister: false,
      registerType: "prompt",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
        globIgnores: ["**/sw.js", "**/workbox-*.js"],
      },
      manifest: {
        name: "Bolt Club HQ",
        short_name: "Bolt Club",
        description: "Sessions, RSVPs, money and polls for the club.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#fbf8f3",
        theme_color: "#272e38",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "/icons/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      devOptions: { enabled: false },
    }),
    pwaHead(),
  ],
});
