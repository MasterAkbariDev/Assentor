import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.resolve(here, "..", name, "src");

// The UI imports the protocol, ui-shared and browser-safe engine modules (the
// RPC client, review ranking) through `#assentor/*`; never Node code.
export default defineConfig({
  root: here,
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "#assentor/protocol": pkg("protocol"),
      "#assentor/ui-shared": pkg("ui-shared"),
      "#assentor/engine": pkg("engine"),
    },
  },
  build: {
    outDir: path.resolve(here, "dist"),
    emptyOutDir: true,
    sourcemap: false,
    // serve's CSP allows no inline script; keep the module preload polyfill out of the HTML.
    modulePreload: { polyfill: false },
  },
});
