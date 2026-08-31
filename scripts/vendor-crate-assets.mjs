#!/usr/bin/env node
// Copies the files three crates compile in, but which live at the workspace
// root, into those crates so `cargo publish` carries them.
//
// Why any of this exists: `cargo publish` packages a crate's own directory and
// nothing above it. Three crates read shared files from the workspace root —
// the built dashboard, the bundled debug skill, the frozen MCP contract — and
// each would otherwise publish without them. `nomoreide-core` failed exactly
// this way on its first dry run, with three "no such file" errors.
//
// The workspace copy stays the single source of truth. Each crate's `build.rs`
// prefers it and only falls back to what this writes, so a checkout can never
// compile a stale vendored copy; the fallback is what a *published* crate has,
// there being no workspace above it.
//
// Everything written here is gitignored build output. `include` in each
// crate's Cargo.toml is what stops cargo skipping it for that reason.

import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ASSETS = [
  {
    crate: "nomoreide-daemon",
    from: "dist/web/client",
    to: "web-client",
    hint: "Run `npm run build` — publishing without it ships a daemon with no UI.",
  },
  {
    crate: "nomoreide-core",
    from: "profiles/nomoreide-debug/skills/nomoreide-debug",
    to: "vendored/profiles/nomoreide-debug/skills/nomoreide-debug",
    hint: "The bundled debug skill is checked in; this should not be missing.",
  },
  {
    // The one fixture rather than the directory holding it: the other sixteen
    // belong to the parity harness and have no business in a published crate.
    crate: "nomoreide-mcp",
    from: "test/fixtures/mcp-contract-v1.json",
    to: "vendored/test/fixtures/mcp-contract-v1.json",
    hint: "The frozen MCP contract is checked in; this should not be missing.",
  },
];

let failed = false;

for (const asset of ASSETS) {
  const source = join(root, asset.from);
  const destination = join(root, "crates", asset.crate, asset.to);

  if (!existsSync(source)) {
    console.error(`missing ${asset.from}\n  ${asset.hint}`);
    failed = true;
    continue;
  }

  // Replace rather than merge. Vite content-hashes its filenames, so merging
  // would pile every past build's assets into the package — megabytes of files
  // nothing references, growing with each release.
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });

  const [files, bytes] = measure(destination);
  console.log(`  ${asset.crate}: ${files} file(s), ${kb(bytes)} -> ${asset.to}`);
}

if (failed) process.exit(1);

function measure(path) {
  if (!statSync(path).isDirectory()) return [1, statSync(path).size];
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const [f, b] = measure(join(path, entry.name));
    files += f;
    bytes += b;
  }
  return [files, bytes];
}

function kb(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;
}
