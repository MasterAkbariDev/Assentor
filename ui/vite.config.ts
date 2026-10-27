import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

// The UI imports browser-safe engine modules through `@engine/*` (the
// contract, the RPC client and the shared seat reducer); never Node code.
export default defineConfig({
  root: here,
  base: "./",
  plugins: [react()],
  resolve: {
    alias: { "@engine": path.resolve(here, "../src") },
  },
  build: {
    outDir: path.resolve(here, "dist"),
    emptyOutDir: true,
    sourcemap: false,
    // serve's CSP allows no inline script; keep the module preload polyfill out of the HTML.
    modulePreload: { polyfill: false },
  },
});
