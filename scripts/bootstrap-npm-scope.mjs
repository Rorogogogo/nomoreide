// One-time bootstrap for the four platform package names.
//
//   npm login && node scripts/bootstrap-npm-scope.mjs [--publish]
//
// npm will not let you add a trusted publisher to a package that does not
// exist, and the release workflow cannot create one because it authenticates
// *as* a trusted publisher — so the names have to exist before OIDC can be
// configured for them. This publishes a 0.0.0 placeholder for each, which is
// the smallest thing that breaks that circle. It is needed exactly once; every
// release after it publishes over these with no token involved.
//
// Without --publish it only writes the packages and prints what it would run,
// because publishing is public and effectively permanent (npm allows unpublish
// for 72 hours and not always).
import { mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const TARGETS = [
  { pkg: "cli-darwin-arm64", os: "darwin", cpu: "arm64" },
  { pkg: "cli-darwin-x64", os: "darwin", cpu: "x64" },
  { pkg: "cli-linux-x64", os: "linux", cpu: "x64" },
  { pkg: "cli-linux-arm64", os: "linux", cpu: "arm64" },
];
const OUT = "npm-bootstrap";
const publish = process.argv.includes("--publish");

await rm(OUT, { recursive: true, force: true });
for (const { pkg, os, cpu } of TARGETS) {
  const dir = join(OUT, pkg);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: `@nomoreide/${pkg}`,
        version: "0.0.0",
        description: `Placeholder reserving the NoMoreIDE ${os} ${cpu} binary package. Replaced by the first real release.`,
        license: "AGPL-3.0-only",
        repository: { type: "git", url: "git+https://github.com/Rorogogogo/nomoreide.git" },
        homepage: "https://www.nomoreide.com",
        os: [os],
        cpu: [cpu],
        files: ["README.md"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(dir, "README.md"),
    `# @nomoreide/${pkg}\n\nPlaceholder. This name will carry the prebuilt NoMoreIDE binary for ${os} ${cpu}.\n\nDo not depend on it directly — install [\`nomoreide\`](https://www.npmjs.com/package/nomoreide), whose optional dependencies resolve to exactly one of these for your platform.\n`,
  );
  // An absolute path, because `npm publish a/b` is read as the GitHub
  // shorthand `owner/repo` rather than a directory — the first attempt went
  // looking for `github.com/npm-bootstrap/cli-darwin-arm64.git`.
  const target = resolve(dir);
  if (publish) {
    console.log(`publishing @nomoreide/${pkg}@0.0.0 …`);
    execFileSync("npm", ["publish", "--access", "public", target], { stdio: "inherit" });
  } else {
    console.log(`  npm publish --access public ${target}`);
  }
}
console.log(
  publish
    ? "\nDone. Now add a trusted publisher to each of the four on npmjs.com:\n  repo Rorogogogo/nomoreide, workflow cli-release.yml, no environment."
    : "\nDry run. Re-run with --publish once `npm whoami` shows you are logged in.",
);
