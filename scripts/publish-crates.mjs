#!/usr/bin/env node
// Publishes the workspace to crates.io, in dependency order.
//
// Order is not a preference. Every crate names its siblings by `version` as
// well as `path` — crates.io rejects a bare path dependency — so cargo will
// not package `nomoreide-daemon` until `nomoreide-core` and the rest are
// resolvable *from the registry*. Publishing out of order fails with
// "no matching package named ...", which is the same error you get from
// publishing in order too fast, because the index takes a moment to catch up.
// Hence the wait between each one.
//
// `nomoreide-tauri` is absent on purpose: it is `publish = false`, being the
// desktop app rather than anything to depend on.
//
//   node scripts/publish-crates.mjs --dry-run   # validate without publishing
//   node scripts/publish-crates.mjs             # the real thing, irreversible
//
// A published version can never be replaced — only yanked, which hides it
// without freeing the number — so the dry run is worth its minute.

import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// Dependency order: nothing here may depend on anything below it. `needs`
// names the siblings each one resolves *from the registry* at package time,
// which is what makes the order mandatory rather than tidy.
const CRATES = [
  { name: "nomoreide-core", needs: [] },
  { name: "nomoreide-daemon-client", needs: [] },
  { name: "nomoreide-actions", needs: ["nomoreide-core"] },
  {
    name: "nomoreide-daemon",
    needs: ["nomoreide-actions", "nomoreide-core", "nomoreide-daemon-client"],
  },
  {
    name: "nomoreide-mcp",
    needs: ["nomoreide-actions", "nomoreide-core", "nomoreide-daemon-client"],
  },
  {
    name: "nomoreide-cli",
    needs: [
      "nomoreide-core",
      "nomoreide-daemon",
      "nomoreide-daemon-client",
      "nomoreide-mcp",
    ],
  },
  // The name people type. A front door over `nomoreide-cli`, so it publishes
  // last and carries nothing of its own.
  { name: "nomoreide", needs: ["nomoreide-cli"] },
];

const dryRun = process.argv.includes("--dry-run");

const run = (command, arguments_, options = {}) =>
  execFileSync(command, arguments_, { stdio: "inherit", ...options });

// The dashboard has to be inside the daemon crate before cargo reads it: the
// package is built from files on disk, and `dist/` is both outside the crate
// and gitignored.
run("node", ["scripts/vendor-crate-assets.mjs"]);

const version = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
).packages.find((p) => p.name === "nomoreide-cli").version;

console.log(
  `\n${dryRun ? "Dry run:" : "Publishing"} ${CRATES.length} crates at ${version}\n`,
);

let skipped = 0;

for (const [index, entry] of CRATES.entries()) {
  const crate = entry.name;
  console.log(`\n=== [${index + 1}/${CRATES.length}] ${crate} ===`);

  if (alreadyPublished(crate, version)) {
    console.log(`${crate} ${version} is already on crates.io; skipping.`);
    continue;
  }

  // A dry run cannot package a crate whose siblings are not on the registry —
  // cargo fails at "failed to prepare local package for uploading", because it
  // has a version to resolve and nowhere to resolve it from. That is cargo's
  // ordering constraint, not a fault in this crate, so say so and move on
  // rather than reporting a failure the first real publish would not hit.
  if (dryRun) {
    const missing = entry.needs.filter((need) => !alreadyPublished(need, version));
    if (missing.length > 0) {
      console.log(
        `skipped: needs ${missing.join(", ")} on crates.io first. ` +
          `A real run publishes those before reaching this one.`,
      );
      skipped += 1;
      continue;
    }
  }

  run("cargo", [
    "publish",
    "-p",
    crate,
    // The vendored dashboard is gitignored, so the tree is "dirty" by
    // definition at publish time. `include` in the daemon's manifest is what
    // decides the file list; this only stops cargo objecting to the untracked
    // directory existing.
    "--allow-dirty",
    ...(dryRun ? ["--dry-run"] : []),
  ]);

  if (dryRun || crate === CRATES.at(-1).name) continue;

  // Wait for the index rather than sleeping a fixed guess: the next crate
  // cannot resolve this one until it appears, and how long that takes is not
  // ours to predict.
  process.stdout.write(`waiting for ${crate} ${version} to appear in the index`);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(5000);
    if (alreadyPublished(crate, version)) {
      console.log(" — available");
      break;
    }
    process.stdout.write(".");
    if (attempt === 59) {
      console.error(
        `\n${crate} ${version} never appeared. It may still land; re-run this ` +
          `script and it will skip what is already published.`,
      );
      process.exit(1);
    }
  }
}

console.log(
  dryRun
    ? `\nDry run clean. Nothing was published.` +
        (skipped > 0
          ? ` ${skipped} crate(s) could not be packaged yet because their ` +
            `dependencies are not on crates.io — that resolves itself as the ` +
            `real run publishes in order.`
          : "")
    : `\nPublished ${CRATES.length} crates at ${version}. ` +
        `\`cargo install nomoreide-cli\` serves the dashboard from the binary.`,
);

/// Whether crates.io already holds this exact version — which makes a re-run
/// after a partial failure safe rather than an error.
function alreadyPublished(crate, wanted) {
  try {
    const body = execFileSync(
      "curl",
      [
        "-sS",
        "--max-time",
        "20",
        // crates.io answers 403 to a request with no User-Agent, which parses
        // as neither a crate nor a 404 — without this, every lookup failed
        // closed and the "already published" skip never fired.
        "-A",
        "nomoreide-release (https://github.com/Rorogogogo/nomoreide)",
        `https://crates.io/api/v1/crates/${crate}`,
      ],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(body);
    return (parsed.versions ?? []).some((entry) => entry.num === wanted);
  } catch {
    // A crate that has never been published 404s, and a network blip should
    // not read as "already there" — either way, let cargo be the authority.
    return false;
  }
}
