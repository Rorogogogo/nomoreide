import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagePath = resolve(root, "package.json");
const packageLockPath = resolve(root, "package-lock.json");
const dashboardPackagePath = resolve(root, "apps/dashboard/package.json");
const tauriConfigPath = resolve(root, "crates/nomoreide-tauri/tauri.conf.json");
const cargoManifestPath = resolve(root, "Cargo.toml");
const cargoLockPath = resolve(root, "Cargo.lock");
const rustWorkspacePackages = [
  "nomoreide",
  "nomoreide-actions",
  "nomoreide-cli",
  "nomoreide-core",
  "nomoreide-daemon",
  "nomoreide-daemon-client",
  "nomoreide-mcp",
  "nomoreide-remote-protocol",
  "nomoreide-tauri",
];

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

const cargoManifest = replaceWorkspaceVersion(
  readFileSync(cargoManifestPath, "utf8"),
  version,
  "Cargo.toml",
);
const cargoLock = replaceWorkspacePackageVersions(
  readFileSync(cargoLockPath, "utf8"),
  version,
  rustWorkspacePackages,
);

// Every crate depends on its siblings by path *and* version, because
// crates.io rejects a bare path dependency — it has no path to resolve. That
// version is a literal in seven manifests, so a bump that missed them would
// leave a release publishing `nomoreide-cli` 0.4.0 against `nomoreide-core`
// 0.3.0, which resolves to the *previous* release from the registry. `--check`
// covers these for the same reason.
const crateManifests = rustWorkspacePackages.map((name) => {
  const path = resolve(root, `crates/${name}/Cargo.toml`);
  return [path, replaceSiblingVersions(readFileSync(path, "utf8"), version, name)];
});

const expectedFiles = [
  ...crateManifests,
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

function replaceWorkspaceVersion(content, nextVersion, label) {
  const workspacePattern = /(\[workspace\.package\][\s\S]*?\nversion = ")[^"]+(")/;
  if (!workspacePattern.test(content)) {
    throw new Error(`Could not find the workspace package version in ${label}.`);
  }
  return content.replace(workspacePattern, `$1${nextVersion}$2`);
}

function replaceSiblingVersions(content, nextVersion, label) {
  const siblingPattern =
    /(nomoreide-[a-z-]+ = \{ path = "\.\.\/[a-z-]+", version = ")[^"]+(")/g;
  const updated = content.replace(siblingPattern, `$1${nextVersion}$2`);
  // A crate with no siblings — `nomoreide-core` — is the expected case, not a
  // failure, so unlike the two below this does not insist on a match.
  if (updated !== content && !updated.includes(nextVersion)) {
    throw new Error(`Failed to set sibling versions in crates/${label}/Cargo.toml.`);
  }
  return updated;
}

function replaceWorkspacePackageVersions(content, nextVersion, packageNames) {
  let updated = content;
  for (const packageName of packageNames) {
    const packagePattern = new RegExp(
      `(\\[\\[package\\]\\]\\nname = "${packageName}"\\nversion = ")[^"]+(")`,
    );
    if (!packagePattern.test(updated)) {
      throw new Error(`Could not find ${packageName} in Cargo.lock.`);
    }
    updated = updated.replace(packagePattern, `$1${nextVersion}$2`);
  }
  return updated;
}
