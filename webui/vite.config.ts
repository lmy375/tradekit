import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Single-page bundle. Output goes to ../dist/webui so tradekit-web can serve it.
// The dev server proxies /api to a locally-running `tradekit web` (default port 3030)
// so React HMR works without losing the token-auth flow.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../dist/webui",
    emptyOutDir: true,
    // Use relative asset paths so the bundle works whether mounted at / or /webui.
    assetsDir: "assets",
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3030",
    },
  },
});
