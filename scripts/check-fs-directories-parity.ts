/**
 * Phase 6 parity gate for the directory picker:
 *
 *   GET /api/fs/directories
 *
 * One endpoint, and almost all of it is about what a listing *omits* and what
 * order the rest comes back in.
 *
 * **Sorting is `localeCompare`.** Folders first, then files, each group sorted
 * by the platform's collation rather than by byte order — so `alpha` sorts
 * before `Beta`, and an underscore does not sort where its code point says it
 * should. Reproducing that outside V8 is the whole risk in this slice, so the
 * fixture plants names chosen to break a naive comparison: mixed case, a
 * leading underscore, a leading dot, a digit, a space, and an accent.
 *
 * **Two directory names are skipped and nothing else is.** `.git` and
 * `node_modules` never appear; every other dotfile directory does.
 *
 * **`files` is a literal `"1"`.** Not "truthy" — `files=true` and `files=0`
 * both leave files out.
 *
 * **A failure is not handled at all.** A path that is not there, or that is a
 * file, throws out of `readdir` and escapes to the dispatcher as a 500. There
 * is no "directory not found" answer.
 *
 * The two cases that fall back to the daemon's own cwd have their `entries`
 * redacted: that directory is this repository, several agents write to it, and
 * the two runtimes read it a few milliseconds apart. `path` and `parent` are
 * still compared, which is what those cases are for.
 *
 * Usage:
 *   node --import tsx scripts/check-fs-directories-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";

const argv = process.argv.slice(2).filter((a) => a !== "--dump");
const dump = process.argv.slice(2).includes("--dump");
if (argv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-fs-directories-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST";
  readonly query: string;
  /** Keys replaced before diffing, for a listing of a directory others write to. */
  readonly redact?: readonly string[];
}

const encode = encodeURIComponent;

/** `W` is replaced with each runtime's own workspace per request. */
const steps: readonly Step[] = [
  // --- the fallback ----------------------------------------------------------
  // No path at all, and a blank one, both list the daemon's own cwd.
  { name: "browse/no-path", method: "GET", query: "", redact: ["entries"] },
  { name: "browse/a-blank-path", method: "GET", query: "path=%20%20", redact: ["entries"] },

  // --- a real listing --------------------------------------------------------
  { name: "browse/a-directory", method: "GET", query: "path=W" },
  { name: "browse/with-files", method: "GET", query: "path=W&files=1" },
  // `files` is compared to the string "1", so neither of these includes files.
  { name: "browse/files-is-zero", method: "GET", query: "path=W&files=0" },
  { name: "browse/files-is-true", method: "GET", query: "path=W&files=true" },
  { name: "browse/files-is-blank", method: "GET", query: "path=W&files=" },
  { name: "browse/an-empty-directory", method: "GET", query: "path=W%2Fempty" },
  // Only `.git` and `node_modules` are skipped; `.hidden` is a listing like any
  // other, and so is what is inside a skipped name.
  { name: "browse/a-dotfile-directory", method: "GET", query: "path=W%2F.hidden&files=1" },
  { name: "browse/inside-node-modules", method: "GET", query: "path=W%2Fnode_modules&files=1" },

  // --- how a path is resolved ------------------------------------------------
  { name: "browse/a-trailing-slash", method: "GET", query: "path=W%2F" },
  { name: "browse/a-dot-segment", method: "GET", query: "path=W%2F.%2Fempty" },
  { name: "browse/a-dot-dot-segment", method: "GET", query: "path=W%2F.hidden%2F..%2Fempty" },
  { name: "browse/a-double-slash", method: "GET", query: "path=W%2F%2Fempty" },
  { name: "browse/a-symlink-to-a-directory", method: "GET", query: "path=W%2Flink" },
  { name: "browse/the-filesystem-root-parent", method: "GET", query: "path=%2F" },
  // Relative, so it resolves against the daemon's cwd rather than the
  // workspace — and nothing by that name is there.
  { name: "browse/a-relative-path", method: "GET", query: `path=${encode("no-such-directory-xyz")}` },

  // --- failures --------------------------------------------------------------
  { name: "browse/a-directory-that-is-not-there", method: "GET", query: "path=W%2Fmissing" },
  { name: "browse/a-file-rather-than-a-directory", method: "GET", query: "path=W%2Fplain.txt" },
  { name: "browse/a-symlink-to-a-file", method: "GET", query: "path=W%2Ffilelink" },
  { name: "browse/a-null-byte", method: "GET", query: "path=W%2Fempty%00" },
  { name: "browse/wrong-method", method: "POST", query: "path=W" },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const credential = await import("node:fs/promises")
    .then((fs) => fs.readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8"))
    .then((value) => value.trim())
    .catch(() => "");
  const headers: Record<string, string> = credential
    ? { authorization: `Bearer ${credential}` }
    : {};
  const query = step.query.split("W").join(encode(runtime.workspace));
  const response = await fetch(
    `http://127.0.0.1:${runtime.port}/api/fs/directories${query ? `?${query}` : ""}`,
    { method: step.method, headers },
  );
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* compared as the text it was */
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body: parsed };
}

function erase(value: string, runtime: Runtime): string {
  return value.split(`/private${runtime.home}`).join("<home>").split(runtime.home).join("<home>");
}

function scrub(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => scrub(item, keys));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) =>
        keys.includes(key) ? [key, "<redacted>"] : [key, scrub(item, keys)],
      ),
    );
  }
  return value;
}

function normalize(answer: Answer, runtime: Runtime, redact: readonly string[] = []): Answer {
  const body = JSON.parse(erase(JSON.stringify(answer.body), runtime));
  return { ...answer, body: redact.length ? scrub(body, redact) : body };
}

const root = await mkdtemp(join(tmpdir(), "nmi-fs-directories-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

/**
 * Names chosen to break a byte-order sort. `localeCompare` puts `alpha` before
 * `Beta`, ignores the leading punctuation in `_under` rather than sorting it by
 * code point, and treats `Éclair` as an `e`.
 */
const DIRECTORIES = [
  "alpha",
  "Beta",
  "_under",
  "zeta",
  "Zulu",
  "10-ten",
  "2-two",
  "dir with space",
  // Lowercase on purpose. Against `eclair` below it differs by *accent
  // alone*, which is the only way the accent level decides an order — with an
  // uppercase spelling the case level reaches the same answer and hides it.
  "éclair",
  // Same letters as `éclair` once the accent is folded, so these two are
  // separated by the *accent* level rather than by the primary one. `éclair`
  // `Éclair` is not planted beside them: on a case-insensitive filesystem it
  // is the same directory, which is also why no pair here reaches the case
  // level.
  "eclair",
  ".hidden",
  ".git",
  "node_modules",
  "empty",
];
const FILES = ["a.txt", "B.txt", "_note.md", ".dotfile", "plain.txt", "1.log"];

async function seed(runtime: Runtime): Promise<void> {
  const w = runtime.workspace;
  for (const name of DIRECTORIES) await mkdir(join(w, name), { recursive: true });
  for (const name of FILES) await writeFile(join(w, name), "x\n");
  // Something inside each skipped directory, so "skipped" is about the name
  // rather than about being empty.
  await writeFile(join(w, ".git", "HEAD"), "ref: refs/heads/main\n");
  await mkdir(join(w, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(w, "node_modules", "pkg", "index.js"), "\n");
  await writeFile(join(w, ".hidden", "inside.txt"), "\n");
  await symlink(join(w, "alpha"), join(w, "link"));
  await symlink(join(w, "plain.txt"), join(w, "filelink"));
}

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({
        version: 1,
        services: [],
        bundles: [],
        databases: [],
        gitRepositories: [],
      }),
      () => [],
    );
    await seed(runtime);
    await harness.startDaemon(runtime, {});
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const step of steps) {
    const answers = {
      reference: await send(reference, step),
      candidate: await send(candidate, step),
    };
    if (dump) {
      console.log(`--- ${step.name} ---`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
    }
    try {
      assert.deepStrictEqual(
        normalize(answers.candidate, candidate, step.redact),
        normalize(answers.reference, reference, step.redact),
      );
      console.log(`ok   ${step.name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${step.name}`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

if (failures > 0) {
  console.log(`\nfs-directories parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nfs-directories parity: ${steps.length} cases match`);
