import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    // The Worker (src/worker/index.ts) serves /healthz and /api; everything else
    // is static assets from the same origin. vite-plugin-pwa (injectManifest)
    // is added in S0.3.
    cloudflare(),
  ],
});
