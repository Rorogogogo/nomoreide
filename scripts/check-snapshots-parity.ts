/**
 * Phase 6 parity gate for working-tree snapshots:
 *
 *   GET    /api/snapshots
 *   POST   /api/snapshots
 *   DELETE /api/snapshots/:sha
 *   PATCH  /api/snapshots/:sha
 *   GET    /api/snapshots/:sha/files
 *   GET    /api/snapshots/:sha/diff
 *   POST   /api/snapshots/:sha/restore
 *
 * **A snapshot's identity is unstable and its content is not.** The sha and the
 * timestamp differ between two runtimes that took the same snapshot a
 * millisecond apart, so both are redacted; the *ref name* is only redacted as
 * far as its epoch prefix, because the rest of it is the slug the label became
 * and that is worth comparing. Everything else — labels, statuses, paths, the
 * diff text — is compared as it stands. Blob hashes inside a diff are content
 * hashes, so they match across runtimes even when the commits do not.
 *
 * **Cases have to name a sha they cannot know.** Each side's shas are its own,
 * so a step that needs one says which *label* it means and the sha is looked up
 * per runtime immediately before the request.
 *
 * **Some steps change the working tree.** A snapshot is only interesting
 * against a tree that has moved, so several steps modify, add, or delete a file
 * in each runtime's workspace first. That is also how the one silent divergence
 * in this slice is observable: a file that is *tracked and also ignored* is
 * carried by a capture seeded from HEAD and dropped by one seeded from nothing,
 * and the two are indistinguishable until the file is deleted and the snapshot
 * is asked what changed.
 *
 * **Every failure is a 400**, including a sha that is a real commit but not a
 * snapshot. The refusal is the namespace guard, and it is the reason restore
 * cannot check out an arbitrary commit.
 *
 * Usage:
 *   node --import tsx scripts/check-snapshots-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";

const run = promisify(execFile);

const argv = process.argv.slice(2).filter((a) => a !== "--dump");
const dump = process.argv.slice(2).includes("--dump");
if (argv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-snapshots-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** `{{SHA}}` is replaced with the sha resolved from `shaOfLabel`. */
  readonly path: string;
  readonly body?: string;
  /** Which snapshot `{{SHA}}` means, by the label it was created with. */
  readonly shaOfLabel?: string;
  /** Change the working tree before the request. */
  readonly mutate?: (runtime: Runtime) => Promise<void>;
}

const steps: readonly Step[] = [
  // --- an empty namespace ----------------------------------------------------
  { name: "list/empty", method: "GET", path: "/api/snapshots" },

  // --- taking snapshots ------------------------------------------------------
  // A blank or missing label is not refused; it is named for you.
  { name: "create/no-body", method: "POST", path: "/api/snapshots" },
  { name: "create/a-blank-label", method: "POST", path: "/api/snapshots", body: '{"label":"   "}' },
  { name: "create/a-label-that-is-a-number", method: "POST", path: "/api/snapshots", body: '{"label":7}' },
  { name: "create/a-label", method: "POST", path: "/api/snapshots", body: '{"label":"  first checkpoint  "}' },
  // The slug is what survives into the ref name, so these two say what
  // "nothing nameable" and "cut to length" mean there.
  { name: "create/a-label-with-nothing-nameable", method: "POST", path: "/api/snapshots", body: '{"label":"快照 ✅"}' },
  { name: "create/a-very-long-label", method: "POST", path: "/api/snapshots", body: `{"label":"${"long-".repeat(20)}end"}` },
  // A tab is not a line break, so it stays inside the subject — and the label
  // is read back out of a tab-separated listing.
  { name: "create/a-label-with-a-tab", method: "POST", path: "/api/snapshots", body: '{"label":"tabbed\\tlabel"}' },
  { name: "create/a-label-with-a-newline", method: "POST", path: "/api/snapshots", body: '{"label":"two\\nlines"}' },
  // Its own snapshot to relabel, so the rename cases do not have to name one
  // whose stored label git may have reflowed.
  { name: "create/a-label-to-rename", method: "POST", path: "/api/snapshots", body: '{"label":"to rename"}' },
  { name: "list/after-several", method: "GET", path: "/api/snapshots" },

  // --- what changed since ----------------------------------------------------
  { name: "files/nothing-has-changed", method: "GET", path: "/api/snapshots/{{SHA}}/files", shaOfLabel: "first checkpoint" },
  {
    name: "files/after-a-modification",
    method: "GET",
    path: "/api/snapshots/{{SHA}}/files",
    shaOfLabel: "first checkpoint",
    mutate: async (runtime) => writeFile(join(runtime.workspace, "app.txt"), "changed\n"),
  },
  {
    name: "files/after-an-addition",
    method: "GET",
    path: "/api/snapshots/{{SHA}}/files",
    shaOfLabel: "first checkpoint",
    // Untracked, so it only appears because the capture stages everything.
    mutate: async (runtime) => writeFile(join(runtime.workspace, "added.txt"), "new\n"),
  },
  {
    name: "files/an-ignored-file-is-not-listed",
    method: "GET",
    path: "/api/snapshots/{{SHA}}/files",
    shaOfLabel: "first checkpoint",
    mutate: async (runtime) => writeFile(join(runtime.workspace, "ignored.log"), "noise\n"),
  },
  {
    name: "files/after-a-deletion",
    method: "GET",
    path: "/api/snapshots/{{SHA}}/files",
    shaOfLabel: "first checkpoint",
    mutate: async (runtime) => unlink(join(runtime.workspace, "doomed.txt")),
  },
  // The capture is seeded from HEAD, so a file that is tracked *and* ignored is
  // in every snapshot — and deleting it is therefore a change.
  {
    name: "files/after-deleting-a-tracked-but-ignored-file",
    method: "GET",
    path: "/api/snapshots/{{SHA}}/files",
    shaOfLabel: "first checkpoint",
    mutate: async (runtime) => unlink(join(runtime.workspace, "tracked.log")),
  },

  // --- the patch -------------------------------------------------------------
  { name: "diff/everything", method: "GET", path: "/api/snapshots/{{SHA}}/diff", shaOfLabel: "first checkpoint" },
  { name: "diff/one-path", method: "GET", path: "/api/snapshots/{{SHA}}/diff?path=app.txt", shaOfLabel: "first checkpoint" },
  { name: "diff/a-blank-path", method: "GET", path: "/api/snapshots/{{SHA}}/diff?path=%20%20", shaOfLabel: "first checkpoint" },
  { name: "diff/a-path-that-changed-nothing", method: "GET", path: "/api/snapshots/{{SHA}}/diff?path=keep.txt", shaOfLabel: "first checkpoint" },
  { name: "diff/a-path-that-is-not-there", method: "GET", path: "/api/snapshots/{{SHA}}/diff?path=no-such-file", shaOfLabel: "first checkpoint" },

  // --- the sha guard ---------------------------------------------------------
  { name: "guard/a-sha-that-is-too-short", method: "GET", path: "/api/snapshots/abc/files" },
  { name: "guard/a-sha-that-is-too-long", method: "GET", path: `/api/snapshots/${"a".repeat(41)}/files` },
  { name: "guard/a-sha-that-is-not-hexadecimal", method: "GET", path: "/api/snapshots/zzzz/files" },
  // Uppercase passes: the pattern is case-insensitive.
  { name: "guard/an-uppercase-sha", method: "GET", path: "/api/snapshots/ABCDEF/files" },
  // Checked before it is decoded, so this is not `abcd`.
  { name: "guard/a-percent-encoded-sha", method: "GET", path: "/api/snapshots/%61bcd/files" },
  { name: "guard/a-blank-sha", method: "GET", path: "/api/snapshots//files" },
  { name: "guard/a-trailing-slash", method: "GET", path: "/api/snapshots/" },
  // Well-formed, and a real object in the repository — but not a snapshot.
  { name: "guard/a-commit-that-is-not-a-snapshot", method: "GET", path: "/api/snapshots/{{SHA}}/files", shaOfLabel: "<head>" },
  { name: "guard/a-sha-that-does-not-exist", method: "POST", path: "/api/snapshots/abcdef0/restore" },

  // --- methods ---------------------------------------------------------------
  { name: "method/get-on-a-snapshot", method: "GET", path: "/api/snapshots/{{SHA}}", shaOfLabel: "first checkpoint" },
  { name: "method/post-on-files", method: "POST", path: "/api/snapshots/{{SHA}}/files", shaOfLabel: "first checkpoint" },
  { name: "method/delete-on-diff", method: "DELETE", path: "/api/snapshots/{{SHA}}/diff", shaOfLabel: "first checkpoint" },
  { name: "method/get-on-restore", method: "GET", path: "/api/snapshots/{{SHA}}/restore", shaOfLabel: "first checkpoint" },
  // An exact route in the reference, so a wrong method matches nothing and
  // reaches the shell rather than a 405.
  { name: "method/put-on-the-collection", method: "PUT", path: "/api/snapshots" },
  // Wrong method *and* an unusable sha. The method is judged first, so this is
  // a 405 and never reaches the sha guard's 400.
  { name: "method/a-wrong-method-on-a-bad-sha", method: "PUT", path: "/api/snapshots/zzzz" },

  // --- relabelling -----------------------------------------------------------
  { name: "rename/no-body", method: "PATCH", path: "/api/snapshots/{{SHA}}", shaOfLabel: "to rename" },
  { name: "rename/a-blank-label", method: "PATCH", path: "/api/snapshots/{{SHA}}", body: '{"label":"  "}', shaOfLabel: "to rename" },
  { name: "rename/a-label-that-is-a-number", method: "PATCH", path: "/api/snapshots/{{SHA}}", body: '{"label":7}', shaOfLabel: "to rename" },
  { name: "rename/a-label", method: "PATCH", path: "/api/snapshots/{{SHA}}", body: '{"label":"  relabelled  "}', shaOfLabel: "to rename" },
  // The ref name keeps the old slug, and the sha is a new object.
  { name: "rename/the-listing-afterwards", method: "GET", path: "/api/snapshots" },
  { name: "rename/the-old-sha-is-gone", method: "GET", path: "/api/snapshots/{{SHA}}/files", shaOfLabel: "<renamed-old>" },
  { name: "rename/a-sha-that-is-not-a-snapshot", method: "PATCH", path: "/api/snapshots/abcdef0", body: '{"label":"x"}' },

  // --- deleting --------------------------------------------------------------
  { name: "delete/a-snapshot", method: "DELETE", path: "/api/snapshots/{{SHA}}", shaOfLabel: "manual snapshot" },
  { name: "delete/the-listing-afterwards", method: "GET", path: "/api/snapshots" },
  { name: "delete/a-sha-that-is-not-a-snapshot", method: "DELETE", path: "/api/snapshots/abcdef0" },

  // --- restoring -------------------------------------------------------------
  { name: "restore/a-sha-that-is-not-a-snapshot", method: "POST", path: "/api/snapshots/abcdef0/restore" },
  // Puts back the modification and the deletions, and removes the file added
  // since. The pre-restore snapshot it takes first is in the answer.
  { name: "restore/a-snapshot", method: "POST", path: "/api/snapshots/{{SHA}}/restore", shaOfLabel: "first checkpoint" },
  { name: "restore/what-the-tree-looks-like-now", method: "GET", path: "/api/snapshots/{{SHA}}/files", shaOfLabel: "first checkpoint" },
  { name: "restore/the-listing-afterwards", method: "GET", path: "/api/snapshots" },
  // Nothing left to change, so the second one restores no files and deletes
  // nothing — but still takes a snapshot.
  { name: "restore/the-same-snapshot-again", method: "POST", path: "/api/snapshots/{{SHA}}/restore", shaOfLabel: "first checkpoint" },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

async function credentialFor(runtime: Runtime): Promise<Record<string, string>> {
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  return credential ? { authorization: `Bearer ${credential}` } : {};
}

/** The sha a step means, resolved against this runtime's own snapshots. */
async function resolveSha(runtime: Runtime, label: string): Promise<string> {
  if (label === "<head>") {
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: runtime.workspace });
    return stdout.trim();
  }
  if (label === "<renamed-old>") {
    const remembered = renamedOld.get(runtime.label);
    return remembered ?? "0000000";
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/snapshots`, {
    headers: await credentialFor(runtime),
  });
  const payload = (await response.json()) as { snapshots?: Array<{ sha: string; label: string }> };
  const found = payload.snapshots?.find((snapshot) => snapshot.label === label);
  return found?.sha ?? "0000000";
}

/** The sha a rename replaced, per runtime, so it can be asked for afterwards. */
const renamedOld = new Map<string, string>();

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  if (step.mutate) await step.mutate(runtime);
  let path = step.path;
  if (step.shaOfLabel) {
    const sha = await resolveSha(runtime, step.shaOfLabel);
    if (step.name === "rename/a-label") renamedOld.set(runtime.label, sha);
    path = path.split("{{SHA}}").join(sha);
  }
  const headers: Record<string, string> = {
    ...(await credentialFor(runtime)),
    "content-type": "application/json",
  };
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: step.method,
    headers,
    body: step.body,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* compared as the text it was */
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body: parsed };
}

/** Keys whose value is a fact about *when*, not about *what*. */
const VOLATILE = new Set(["sha", "createdAt"]);

function scrub(value: unknown): unknown {
  if (typeof value === "string") {
    // The ref's epoch prefix is the timestamp; its slug is not.
    return value.replace(/refs\/nomoreide\/snapshots\/\d+-/g, "refs/nomoreide/snapshots/<ms>-");
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) =>
        VOLATILE.has(key) ? [key, "<volatile>"] : [key, scrub(item)],
      ),
    );
  }
  return value;
}

function normalize(answer: Answer, runtime: Runtime): Answer {
  const erased = JSON.stringify(answer.body)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>")
    // A refusal quotes the sha it was given, which is this runtime's own.
    .replace(/Not a nomoreide snapshot: [0-9a-f]{4,40}/g, "Not a nomoreide snapshot: <sha>");
  return { ...answer, body: scrub(JSON.parse(erased)) };
}

/** The repository each runtime snapshots: a commit, plus an ignore rule. */
async function seedRepository(runtime: Runtime): Promise<void> {
  const cwd = runtime.workspace;
  await writeFile(join(cwd, "app.txt"), "original\n");
  await writeFile(join(cwd, "keep.txt"), "untouched\n");
  await writeFile(join(cwd, "doomed.txt"), "delete me\n");
  // Tracked *before* it is ignored, which is the state that separates a
  // capture seeded from HEAD from one seeded from nothing.
  await writeFile(join(cwd, "tracked.log"), "tracked and ignored\n");
  const git = (args: string[]) =>
    run("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Gate",
        GIT_AUTHOR_EMAIL: "gate@example.com",
        GIT_COMMITTER_NAME: "Gate",
        GIT_COMMITTER_EMAIL: "gate@example.com",
      },
    });
  await git(["init", "--initial-branch=main", "--quiet"]);
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", "fixture"]);
  // Added after the commit, so `tracked.log` stays tracked while becoming
  // ignored — and `ignored.log` is never tracked at all.
  await writeFile(join(cwd, ".gitignore"), "*.log\n");
  await git(["add", ".gitignore"]);
  await git(["commit", "--quiet", "-m", "ignore logs"]);
}

const root = await mkdtemp(join(tmpdir(), "nmi-snapshots-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      (partial) => ({
        version: 1,
        services: [],
        bundles: [],
        databases: [],
        gitRepositories: [{ name: "demo", path: partial.workspace }],
        selectedGitRepository: "demo",
      }),
      () => [],
    );
    await seedRepository(runtime);
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
        normalize(answers.candidate, candidate),
        normalize(answers.reference, reference),
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
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\nsnapshots parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nsnapshots parity: ${steps.length} cases match`);
