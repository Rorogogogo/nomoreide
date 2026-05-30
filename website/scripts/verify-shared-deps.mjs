import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const websiteRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(websiteRoot, "..");
const sourceRoots = [
  path.join(websiteRoot, "src"),
  path.join(repoRoot, "src/web/client/src"),
];
const packageJson = JSON.parse(
  readFileSync(path.join(websiteRoot, "package.json"), "utf8"),
);
const viteConfig = readFileSync(path.join(websiteRoot, "vite.config.ts"), "utf8");

const dependencies = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
]);
const ignoredSpecifiers = new Set(["@"]);
const ignoredPrefixes = ["./", "../", "/", "@/", "node:"];
const importPatterns = [
  /import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
  /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  /export\s+(?:type\s+)?[^'"]*?\s+from\s+["']([^"']+)["']/g,
];

const specifiers = new Set();
for (const filePath of listSourceFiles(sourceRoots)) {
  const source = readFileSync(filePath, "utf8");
  for (const pattern of importPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (isBareSpecifier(specifier)) {
        specifiers.add(packageNameForSpecifier(specifier));
      }
    }
  }
}

const missingDependencies = [...specifiers].filter((specifier) => !dependencies.has(specifier));
const missingAliases = [...specifiers].filter(
  (specifier) => !viteConfig.includes(`"${specifier}"`),
);

if (missingDependencies.length || missingAliases.length) {
  if (missingDependencies.length) {
    console.error(
      `Missing website dependencies for shared imports: ${missingDependencies.join(", ")}`,
    );
  }
  if (missingAliases.length) {
    console.error(
      `Missing website Vite aliases for shared imports: ${missingAliases.join(", ")}`,
    );
  }
  process.exit(1);
}

console.log(
  `Website shared dependency preflight passed (${specifiers.size} bare packages checked).`,
);

function listSourceFiles(roots) {
  const files = [];
  for (const root of roots) {
    walk(root, files);
  }
  return files;
}

function walk(currentPath, files) {
  const stat = statSync(currentPath);
  if (stat.isDirectory()) {
    for (const name of readdirSync(currentPath)) {
      if (name === "node_modules" || name === "dist") continue;
      walk(path.join(currentPath, name), files);
    }
    return;
  }

  if (/\.(ts|tsx)$/.test(currentPath)) {
    files.push(currentPath);
  }
}

function isBareSpecifier(specifier) {
  if (ignoredSpecifiers.has(specifier)) return false;
  return !ignoredPrefixes.some((prefix) => specifier.startsWith(prefix));
}

function packageNameForSpecifier(specifier) {
  if (!specifier.startsWith("@")) {
    return specifier.split("/")[0];
  }
  const [scope, name] = specifier.split("/");
  return `${scope}/${name}`;
}
