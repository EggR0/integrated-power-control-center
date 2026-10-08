import { defineConfig } from "vite";
import path from "node:path";

// The shared quota module (shared/quota) is the single source of truth for
// quota calculation/formatting. The VSIX webview bundles the same source via
// esbuild (webview/quota-core.js); vite resolves the alias here so both
// programs compute identical numbers.
export default defineConfig({
  resolve: {
    alias: {
      "@shared/quota": path.resolve(__dirname, "..", "Integrated POWER", "shared", "quota", "index.ts"),
    },
  },
});
