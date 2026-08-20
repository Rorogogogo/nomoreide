import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const result = spawnSync(
  "cargo",
  ["metadata", "--format-version", "1", "--no-deps"],
  { cwd: root, encoding: "utf8" },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const metadata = JSON.parse(result.stdout);
const workspacePackages = new Map(
  metadata.packages.map((package_) => [package_.name, package_]),
);
const expectedPackages = [
  "nomoreide-cli",
  "nomoreide-core",
  "nomoreide-daemon",
  "nomoreide-daemon-client",
  "nomoreide-mcp",
  "nomoreide-tauri",
];

for (const packageName of expectedPackages) {
  if (!workspacePackages.has(packageName)) {
    throw new Error(`Missing Rust workspace package: ${packageName}`);
  }
}

function reachesWorkspacePackage(packageName, targetName, visited = new Set()) {
  if (packageName === targetName) {
    return true;
  }
  if (visited.has(packageName)) {
    return false;
  }

  visited.add(packageName);
  const package_ = workspacePackages.get(packageName);
  return package_.dependencies
    .filter((dependency) => workspacePackages.has(dependency.name))
    .some((dependency) =>
      reachesWorkspacePackage(dependency.name, targetName, visited),
    );
}

if (reachesWorkspacePackage("nomoreide-daemon-client", "nomoreide-core")) {
  throw new Error(
    "nomoreide-daemon-client must remain stateless and cannot depend directly or transitively on nomoreide-core",
  );
}

console.log(
  "Rust workspace boundaries are valid; nomoreide-daemon-client does not depend on nomoreide-core.",
);
