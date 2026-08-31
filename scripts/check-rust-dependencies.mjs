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
  "nomoreide-actions",
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

// The one boundary the crate graph enforces: nomoreide-daemon-client holds no
// state, so it cannot reach core.
//
// Note what is deliberately *not* here. nomoreide-actions holds the
// write-capable git operations, but the crate graph is the wrong place to
// restrict who may call them: the reference MCP surface exposes
// `nomoreide_git_push`, so nomoreide-mcp must be able to reach at least part of
// that crate. What an agent may do with git is defined by the MCP tool surface
// and covered by the frozen MCP contract tests, which check the exposed
// tool list against the frozen 90-tool manifest. See nomoreide-actions/src/lib.rs.
const forbidden = [
  {
    from: "nomoreide-daemon-client",
    to: "nomoreide-core",
    reason:
      "nomoreide-daemon-client must remain stateless and cannot depend directly or transitively on nomoreide-core",
  },
];

for (const { from, to, reason } of forbidden) {
  if (reachesWorkspacePackage(from, to)) {
    throw new Error(reason);
  }
}

console.log(
  `Rust workspace boundaries are valid; ${forbidden
    .map(({ from, to }) => `${from} does not depend on ${to}`)
    .join(", and ")}.`,
);
