import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageJson = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as {
  version: string;
};

/**
 * Hand the dev page the daemon's credential, the way the daemon's own shell
 * route does.
 *
 * Every `/api/*` route is behind `require_credential`, and the client reads its
 * bearer token off `window.__NOMOREIDE_WEB__`. The daemon injects that into the
 * HTML it serves — but in dev Vite serves this `index.html`, so nothing injects
 * it and every call answers `401 Authentication required`.
 *
 * `apply: "serve"` keeps this out of `vite build`: a production bundle is served
 * by the daemon, which does the injection itself, and baking a token into built
 * HTML would write one machine's secret into a shipped artifact.
 */
function devCredential() {
  return {
    name: "nomoreide-dev-credential",
    apply: "serve" as const,
    transformIndexHtml(html: string) {
      let credential: string;
      try {
        credential = readFileSync(resolve(homedir(), ".nomoreide/daemon.credential"), "utf8").trim();
      } catch {
        // No daemon running, or no credential yet. The page still loads; its
        // API calls 401 until one exists, which is the same as today.
        return html;
      }
      if (!credential) return html;
      return html.replace(
        "<head>",
        `<head><script>window.__NOMOREIDE_WEB__=${JSON.stringify({ credential })};</script>`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devCredential()],
  root: __dirname,
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  build: {
    outDir: "../../dist/web/client",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4317",
    },
  },
});
