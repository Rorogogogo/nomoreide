#!/usr/bin/env node
// The npm entry point: find the prebuilt binary for this platform and become
// it.
//
// Nothing of NoMoreIDE is implemented here. The four `@nomoreide/cli-*`
// packages are `optionalDependencies`, each declaring the `os` and `cpu` it is
// for, so npm installs exactly the one that matches and skips the rest. This
// file only has to find it and hand over.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

const PACKAGES = {
  "darwin arm64": "@nomoreide/cli-darwin-arm64",
  "darwin x64": "@nomoreide/cli-darwin-x64",
  "linux x64": "@nomoreide/cli-linux-x64",
  "linux arm64": "@nomoreide/cli-linux-arm64",
};

function binaryPath() {
  const key = `${process.platform} ${process.arch}`;
  const name = PACKAGES[key];
  if (!name) {
    throw new Error(
      `NoMoreIDE has no prebuilt binary for ${key}.\n` +
        `Supported: ${Object.keys(PACKAGES).join(", ")}.\n` +
        `Build from source: https://github.com/Rorogogogo/nomoreide`,
    );
  }
  const require = createRequire(import.meta.url);
  let manifest;
  try {
    // Resolving the package's manifest rather than a file inside it: the
    // binary is not a module, so `require.resolve` cannot be pointed at it
    // directly, but the manifest is always there and names the directory.
    manifest = require.resolve(`${name}/package.json`);
  } catch {
    throw new Error(
      `NoMoreIDE's binary package ${name} is not installed.\n` +
        `This usually means npm skipped optional dependencies. Reinstall with:\n` +
        `  npm install -g nomoreide\n` +
        `or install ${name} directly.`,
    );
  }
  const executable = join(
    dirname(manifest),
    "bin",
    process.platform === "win32" ? "nomoreide.exe" : "nomoreide",
  );
  if (!existsSync(executable)) {
    throw new Error(`${name} is installed but has no binary at ${executable}.`);
  }
  return executable;
}

let executable;
try {
  executable = binaryPath();
} catch (error) {
  process.stderr.write(`nomoreide: ${error.message}\n`);
  process.exit(1);
}

// `stdio: "inherit"` is the whole point: `nomoreide mcp` is a stdio server, so
// this process must not sit between the agent and the binary reading or
// buffering anything. It only waits and reports how the child ended.
const child = spawn(executable, process.argv.slice(2), { stdio: "inherit" });
// Forwarded rather than handled, so Ctrl-C reaches the binary and it gets to
// shut its services down instead of being orphaned by a dead parent.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  process.stderr.write(`nomoreide: could not run ${executable}: ${error.message}\n`);
  process.exit(1);
});
// A process killed by a signal has no exit code, and reporting 0 there would
// tell a caller it succeeded.
child.on("exit", (code, signal) => {
  process.exit(signal ? 128 + (process.constants?.signals?.[signal] ?? 0) : (code ?? 0));
});
