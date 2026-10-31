import path from "node:path";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => path.resolve(import.meta.dirname, "packages", name, "src");

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/ui/src/**/*.test.ts", "packages/ui/src/**/*.test.tsx"],
    // UI component tests opt into jsdom with a `// @vitest-environment jsdom` comment.
    environment: "node",
  },
  resolve: {
    // Run workspace packages from source; built code resolves these through package.json "imports".
    alias: {
      "#assentor/protocol": pkg("protocol"),
      "#assentor/ui-shared": pkg("ui-shared"),
      "#assentor/engine": pkg("engine"),
    },
  },
  esbuild: { jsx: "automatic" },
});
