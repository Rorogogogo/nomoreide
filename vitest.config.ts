import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, configDefaults } from "vitest/config";

const dashboardPackage = JSON.parse(
  readFileSync(resolve(__dirname, "apps/dashboard/package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(dashboardPackage.version),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "apps/dashboard/src"),
    },
  },
  test: {
    root: __dirname,
    setupFiles: ["./test/setup.ts"],
    // Local git worktrees are full checkouts; scanning them runs stale copies
    // of the suite against a second React instance.
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
  },
});
