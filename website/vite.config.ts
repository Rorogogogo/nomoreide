import path from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const packageJson = JSON.parse(
  readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
) as { version: string };
const websiteNodeModules = path.resolve(__dirname, "node_modules");
const browserPackageAliases = [
  "@codemirror/lang-css",
  "@codemirror/lang-html",
  "@codemirror/lang-javascript",
  "@codemirror/lang-json",
  "@codemirror/lang-markdown",
  "@codemirror/lang-yaml",
  "@codemirror/language",
  "@codemirror/state",
  "@lezer/highlight",
  "@xterm/addon-fit",
  "@xterm/xterm",
  "@radix-ui/react-slot",
  "class-variance-authority",
  "clsx",
  "codemirror",
  "framer-motion",
  "highlight.js",
  "js-yaml",
  "lucide-react",
  "marked",
  "simple-icons",
  "tailwind-merge",
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../src/web/client/src"),
      ...Object.fromEntries(
        browserPackageAliases.map((packageName) => [
          packageName,
          path.join(websiteNodeModules, packageName),
        ]),
      ),
      react: path.join(websiteNodeModules, "react"),
      "react-dom": path.join(websiteNodeModules, "react-dom"),
      "react-dom/client": path.join(websiteNodeModules, "react-dom/client"),
      "react/jsx-dev-runtime": path.join(websiteNodeModules, "react/jsx-dev-runtime.js"),
      "react/jsx-runtime": path.join(websiteNodeModules, "react/jsx-runtime.js"),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5174,
    host: "127.0.0.1",
  },
});
