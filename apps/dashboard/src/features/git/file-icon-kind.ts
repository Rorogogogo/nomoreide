export type FileIconKind =
  | "code"
  | "config"
  | "data"
  | "document"
  | "generic"
  | "image"
  | "lock"
  | "style"
  | "test";

const codeExtensions = new Set([
  "c",
  "cpp",
  "cs",
  "go",
  "java",
  "js",
  "jsx",
  "kt",
  "mjs",
  "py",
  "rs",
  "swift",
  "ts",
  "tsx",
]);

const configFilenames = new Set([
  ".env",
  ".gitignore",
  "components.json",
  "dockerfile",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
]);

const configExtensions = new Set(["conf", "config", "ini", "toml", "yaml", "yml"]);
const dataExtensions = new Set(["csv", "json", "sql", "xml"]);
const documentExtensions = new Set(["md", "mdx", "rst", "txt"]);
const imageExtensions = new Set(["gif", "jpeg", "jpg", "png", "svg", "webp"]);
const lockFilenames = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
const styleExtensions = new Set(["css", "less", "sass", "scss"]);

export function fileIconKind(path: string): FileIconKind {
  const filename = path.split("/").pop()?.toLowerCase() ?? path.toLowerCase();
  const extension = filename.includes(".") ? filename.split(".").pop() ?? "" : "";

  if (lockFilenames.has(filename) || filename.endsWith(".lock")) return "lock";
  if (isTestFile(filename)) return "test";
  if (configFilenames.has(filename) || configExtensions.has(extension)) return "config";
  if (styleExtensions.has(extension)) return "style";
  if (imageExtensions.has(extension)) return "image";
  if (documentExtensions.has(extension)) return "document";
  if (dataExtensions.has(extension)) return "data";
  if (codeExtensions.has(extension)) return "code";
  return "generic";
}

function isTestFile(filename: string): boolean {
  return (
    filename.includes(".test.") ||
    filename.includes(".spec.") ||
    filename.endsWith("_test.go")
  );
}
