// Turns the release archives into the npm packages that carry them.
//
//   node scripts/build-npm-packages.mjs <version> <archive-dir> <out-dir>
//
// `nomoreide` on npm is a shim (npm/nomoreide) whose `optionalDependencies`
// are one package per platform. npm reads each one's `os`/`cpu` and installs
// only the matching one, so a user downloads a single binary rather than four.
// The shim's `bin/nomoreide.js` finds it and execs it.
//
// Each platform package reproduces the archive's own layout — `bin/nomoreide`
// beside `share/nomoreide/web/client` — because that is a layout the daemon
// already knows how to find its dashboard in (`asset_roots()` looks at
// `<exe dir>/../share/nomoreide/web/client`). Nothing in Rust changes.
import { cp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const TARGETS = [
  { target: "aarch64-apple-darwin", pkg: "cli-darwin-arm64", os: "darwin", cpu: "arm64" },
  { target: "x86_64-apple-darwin", pkg: "cli-darwin-x64", os: "darwin", cpu: "x64" },
  { target: "x86_64-unknown-linux-gnu", pkg: "cli-linux-x64", os: "linux", cpu: "x64" },
  { target: "aarch64-unknown-linux-gnu", pkg: "cli-linux-arm64", os: "linux", cpu: "arm64" },
];

const [version, archiveDir, outDir] = process.argv.slice(2);
if (!version || !archiveDir || !outDir) {
  console.error("usage: build-npm-packages.mjs <version> <archive-dir> <out-dir>");
  process.exit(2);
}

const REPO = "https://github.com/Rorogogogo/nomoreide";
const root = resolve(process.cwd());
const shared = {
  version,
  license: "AGPL-3.0-only",
  repository: { type: "git", url: `git+${REPO}.git` },
  homepage: "https://www.nomoreide.com",
  engines: { node: ">=20.0.0" },
};

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const { target, pkg, os, cpu } of TARGETS) {
  // The archive unpacks to a single directory named for itself; find it rather
  // than reconstructing the name, so a change to the archive naming is a
  // failure here instead of a package with no binary in it.
  const unpacked = join(archiveDir, `nomoreide-${version}-${target}`);
  if (!existsSync(unpacked)) {
    console.error(`missing unpacked archive: ${unpacked}`);
    process.exit(1);
  }
  const dir = join(outDir, pkg);
  await mkdir(dir, { recursive: true });
  await cp(join(unpacked, "bin"), join(dir, "bin"), { recursive: true });
  await cp(join(unpacked, "share"), join(dir, "share"), { recursive: true });
  await cp(join(root, "LICENSE"), join(dir, "LICENSE"));
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: `@nomoreide/${pkg}`,
        description: `NoMoreIDE prebuilt binary for ${os} ${cpu}.`,
        ...shared,
        // What makes the whole scheme work: npm refuses to install this on any
        // other platform, so the shim's four optional dependencies resolve to
        // exactly one.
        os: [os],
        cpu: [cpu],
        // `bin` is deliberately absent. The shim owns the `nomoreide` command;
        // if these declared it too, installing would race four packages for
        // the same name in the same bin directory.
        files: ["bin", "share", "LICENSE"],
      },
      null,
      2,
    )}\n`,
  );
  const files = await readdir(join(dir, "bin"));
  console.log(`@nomoreide/${pkg}: ${files.join(", ")} + share/`);
}

// The shim itself, with its optional dependencies pinned to this exact version
// — a range would let npm pair a shim with a binary package built from other
// source.
const shim = join(outDir, "nomoreide");
await mkdir(shim, { recursive: true });
await cp(join(root, "npm/nomoreide/bin"), join(shim, "bin"), { recursive: true });
await cp(join(root, "README.md"), join(shim, "README.md"));
await cp(join(root, "LICENSE"), join(shim, "LICENSE"));
await cp(join(root, "profiles/nomoreide-debug"), join(shim, "profiles/nomoreide-debug"), {
  recursive: true,
});
await writeFile(
  join(shim, "package.json"),
  `${JSON.stringify(
    {
      name: "nomoreide",
      description:
        "AI-native local development workbench: services, logs, Git, databases and agent environments, over MCP, CLI, TUI and a web dashboard.",
      ...shared,
      type: "module",
      bin: { nomoreide: "bin/nomoreide.js" },
      files: ["bin", "profiles/nomoreide-debug", "README.md", "LICENSE"],
      optionalDependencies: Object.fromEntries(
        TARGETS.map(({ pkg }) => [`@nomoreide/${pkg}`, version]),
      ),
      keywords: ["mcp", "ai", "agent", "devtools", "workbench", "claude", "codex"],
    },
    null,
    2,
  )}\n`,
);
console.log(`nomoreide: shim -> ${TARGETS.length} platform packages at ${version}`);
