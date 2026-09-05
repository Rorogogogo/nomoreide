#!/usr/bin/env node
/**
 * Keep `target/` from eating the disk.
 *
 * **Why this is worth a script rather than an occasional `cargo clean`.** This
 * workspace builds nine crates plus Tauri, in debug and release, with a test
 * binary per integration suite — and several agents may be building at once.
 * It reached **120 GiB** before anyone noticed. Disk is the obvious cost and
 * the smaller one: a bloated `target/` also makes builds *slower*, and on macOS
 * a large enough one has wedged them outright (a fresh `CARGO_TARGET_DIR` built
 * in 24 seconds what a fat one could not finish at all).
 *
 * So the policy is tiered, cheapest first, and every tier is safe — nothing
 * here can corrupt a build tree. The worst case of deleting too much is a
 * slower next build, which is exactly what `cargo clean` costs anyway.
 *
 *   1. **Incremental caches** (`target/*​/incremental`). Pure cache, rebuilt on
 *      demand, and routinely a third of the tree. Pruned whenever they exist,
 *      because keeping them only speeds up a rebuild of code you have *already*
 *      built once, which is not what a machine sitting at 100 GiB needs.
 *   2. **A full clean**, but only past `--max-gb`. This is the one with a real
 *      cost — the next build is a cold one — so it is gated on the size that
 *      actually hurts rather than run on a timer.
 *
 * Usage:
 *   node scripts/clean-target.mjs            # report, prune caches
 *   node scripts/clean-target.mjs --check    # report only, change nothing
 *   node scripts/clean-target.mjs --max-gb=40
 *   node scripts/clean-target.mjs --force    # full clean regardless of size
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Every build tree this repo is responsible for.
 *
 * The platform's is included deliberately: it is a sibling checkout rather than
 * a workspace member, so `cargo clean` here never reaches it, and it was
 * carrying 20 GiB of its own. A path that does not exist is skipped, so this
 * works in a checkout that has only one of them.
 */
const TARGET_DIRS = [
  join(REPO_ROOT, "target"),
  join(REPO_ROOT, "..", "nomoreide-platform", "backend", "target"),
];

/** Past this, a full clean is worth the cold rebuild it costs. */
const DEFAULT_MAX_GB = 40;

function parseArgs(argv) {
  const args = { check: false, force: false, maxGb: DEFAULT_MAX_GB };
  for (const arg of argv) {
    if (arg === "--check") args.check = true;
    else if (arg === "--force") args.force = true;
    else if (arg.startsWith("--max-gb=")) {
      const value = Number(arg.slice("--max-gb=".length));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`--max-gb needs a positive number, got ${arg}`);
      }
      args.maxGb = value;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown flag ${arg}`);
    }
  }
  return args;
}

/**
 * Size in GiB, via `du`.
 *
 * Shelling out rather than walking the tree in Node: these directories hold
 * upwards of 200,000 files, and `du` answers in about a second where a JS walk
 * takes the better part of a minute. A directory `du` cannot read reports zero
 * rather than throwing — this is a disk-usage report, not an audit.
 */
function sizeGb(dir) {
  if (!existsSync(dir)) return 0;
  try {
    const out = execFileSync("du", ["-sk", dir], { encoding: "utf8" });
    const kb = Number.parseInt(out.trim().split(/\s+/)[0], 10);
    return Number.isFinite(kb) ? kb / 1024 / 1024 : 0;
  } catch {
    return 0;
  }
}

const gb = (value) => `${value.toFixed(1)} GiB`;

/**
 * Delete every `incremental/` directory under a target tree.
 *
 * Looks one level down (`target/debug`, `target/release`, and any custom
 * profile) rather than recursing, because that is where cargo puts them and a
 * deep walk over a tree this size is the thing being avoided.
 */
function pruneIncremental(targetDir, { dryRun }) {
  if (!existsSync(targetDir)) return 0;
  let freed = 0;
  let profiles = [];
  try {
    profiles = readdirSync(targetDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(targetDir, entry.name));
  } catch {
    return 0;
  }
  for (const profile of profiles) {
    const incremental = join(profile, "incremental");
    if (!existsSync(incremental)) continue;
    const before = sizeGb(incremental);
    if (before === 0) continue;
    freed += before;
    if (!dryRun) {
      // `force` so a half-deleted cache from an interrupted run is not an
      // error: the whole point is that this directory is disposable.
      rmSync(incremental, { recursive: true, force: true });
    }
  }
  return freed;
}

function cargoClean(targetDir, { dryRun }) {
  const before = sizeGb(targetDir);
  if (before === 0 || dryRun) return before;
  // `cargo clean` needs the manifest, not the target dir; removing the tree
  // directly is equivalent and works even when the toolchain is mid-upgrade.
  rmSync(targetDir, { recursive: true, force: true });
  return before;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`clean-target: ${error.message}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(
      [
        "Usage: node scripts/clean-target.mjs [--check] [--force] [--max-gb=N]",
        "",
        "  --check      report sizes and change nothing",
        "  --force      full clean regardless of size",
        `  --max-gb=N   full clean past this size (default ${DEFAULT_MAX_GB})`,
      ].join("\n"),
    );
    return;
  }

  const dryRun = args.check;
  const present = TARGET_DIRS.filter((dir) => existsSync(dir));
  if (present.length === 0) {
    console.log("clean-target: nothing to clean, no target directories yet");
    return;
  }

  const totalBefore = present.reduce((sum, dir) => sum + sizeGb(dir), 0);
  console.log(`clean-target: ${gb(totalBefore)} across ${present.length} build tree(s)`);
  for (const dir of present) {
    console.log(`  ${gb(sizeGb(dir)).padStart(10)}  ${dir}`);
  }

  const full = args.force || totalBefore > args.maxGb;
  let freed = 0;

  if (full) {
    console.log(
      args.force
        ? "\n==> full clean (--force)"
        : `\n==> over ${args.maxGb} GiB, full clean`,
    );
    for (const dir of present) {
      freed += cargoClean(dir, { dryRun });
      console.log(`  ${dryRun ? "would remove" : "removed"} ${dir}`);
    }
  } else {
    console.log("\n==> under the limit, pruning incremental caches only");
    for (const dir of present) {
      const cleared = pruneIncremental(dir, { dryRun });
      freed += cleared;
      if (cleared > 0) {
        console.log(`  ${dryRun ? "would free" : "freed"} ${gb(cleared)} in ${dir}`);
      }
    }
    if (freed === 0) console.log("  nothing to prune");
  }

  console.log(
    dryRun
      ? `\nclean-target: ${gb(freed)} would be freed (--check, nothing changed)`
      : `\nclean-target: freed ${gb(freed)}`,
  );
}

main();
