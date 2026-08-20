import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagePath = resolve(root, "package.json");
const packageLockPath = resolve(root, "package-lock.json");
const dashboardPackagePath = resolve(root, "apps/dashboard/package.json");
const tauriConfigPath = resolve(root, "src-tauri/tauri.conf.json");
const cargoManifestPath = resolve(root, "src-tauri/Cargo.toml");
const cargoLockPath = resolve(root, "src-tauri/Cargo.lock");

const arguments_ = process.argv.slice(2);
const checkOnly = arguments_.includes("--check");
const requestedVersion = arguments_.find((argument) => !argument.startsWith("--"));
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const version = requestedVersion ?? packageJson.version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid release version: ${String(version)}`);
}

const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
tauriConfig.version = version;
const dashboardPackage = JSON.parse(readFileSync(dashboardPackagePath, "utf8"));
dashboardPackage.version = version;
const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
packageLock.packages["apps/dashboard"].version = version;

const cargoManifest = replacePackageVersion(
  readFileSync(cargoManifestPath, "utf8"),
  version,
  "src-tauri/Cargo.toml",
);
const cargoLock = replacePackageVersion(
  readFileSync(cargoLockPath, "utf8"),
  version,
  "src-tauri/Cargo.lock",
);

const expectedFiles = [
  [dashboardPackagePath, `${JSON.stringify(dashboardPackage, null, 2)}\n`],
  [packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`],
  [tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`],
  [cargoManifestPath, cargoManifest],
  [cargoLockPath, cargoLock],
];

if (checkOnly) {
  const stale = expectedFiles
    .filter(([path, expected]) => readFileSync(path, "utf8") !== expected)
    .map(([path]) => path.slice(root.length + 1));
  if (stale.length > 0) {
    throw new Error(
      `Release version ${version} is not synchronized in: ${stale.join(", ")}`,
    );
  }
  console.log(`Release versions are synchronized at ${version}.`);
} else {
  for (const [path, content] of expectedFiles) writeFileSync(path, content);
  console.log(`Synchronized dashboard, Tauri, and Cargo versions to ${version}.`);
}

function replacePackageVersion(content, nextVersion, label) {
  const packagePattern = /(\[\[?package\]?\]\s*\nname = "nomoreide"\s*\nversion = ")[^"]+(")/;
  if (!packagePattern.test(content)) {
    throw new Error(`Could not find the nomoreide package version in ${label}.`);
  }
  return content.replace(packagePattern, `$1${nextVersion}$2`);
}
