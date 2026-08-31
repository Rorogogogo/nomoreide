/**
 * Phase 5 agent-profile parity gate.
 *
 * A profile is a saved bundle of MCP servers, skills, and plugins, kept as a
 * directory tree under the user's config. Every tool here reads or writes that
 * tree, so both runtimes are given the same empty one and asked to build it up
 * with the same calls — and the trees they leave behind are compared, not just
 * the answers they gave.
 *
 * Nothing here reads either implementation.
 * The manifests planted in that fixture say `0.0.2`, which is deliberately a
 * version this project has never been. `created_by.version` is written on
 * export and never read back, so a planted one is an arbitrary constant — but
 * while it happened to equal the *current* version, the recording's version
 * tokeniser could not tell the fixture's constant from a value a runtime had
 * produced, and rewrote both. A fixture that matches real output by
 * coincidence is a fixture that stops testing what it names.
 *
 * `test/fixtures/mcp-profiles-parity-v1.json` holds the planted tree and the
 * ordered plan; both runtimes see the same one.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-profiles-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 *   ... --probe   run the reference alone and print what it answered
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { callMcpTool } from "../test/support/mcp-contract.js";
import {
  type FixtureTree,
  type Runtime,
  mcpCommand,
  normalize,
  prepareRuntime,
  pruneBackups,
  recordable,
  recorder,
  repositoryRoot,
  rewritePaths,
  substitute,
} from "./support/mcp-parity-fixture.js";
import { referenceSpec } from "../test/support/runtime-parity.js";

const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const probe = argv.includes("--probe");
const candidateArgv = argv.filter((argument) => !argument.startsWith("--"));
if (candidateArgv.length === 0 && !probe) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-profiles-parity.ts [--dump] [--probe] <candidate-command> [candidate-args...]",
  );
}

interface Step {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  /**
   * Home-relative files to delete from *every* runtime before this step. The
   * fixture plants a config for all three agents, which leaves the "this agent
   * has no config" branch of every reader unreachable; a step that removes one
   * first is how the plan reaches it. Applied to both runtimes, so the two are
   * still asked the same question.
   */
  removeHomeFiles?: string[];
  /**
   * Home-relative files to write before this step, for the states no fixture
   * can start in — a config file that is not valid JSON, say. Written to both
   * runtimes, like the deletions above.
   */
  writeHomeFiles?: Array<{ path: string; contents: string }>;
  /**
   * Home-relative `.tar.gz` archives to build before this step.
   *
   * Reading an archive is the only part of this domain that takes input
   * nobody here wrote, so the malformed ones matter — and none of them can be
   * produced by exporting a profile. `raw` writes the bytes literally, for an
   * archive that is not an archive; otherwise `members` are packed into a real
   * tar, including member paths a well-behaved packer would refuse to write.
   */
  writeHomeArchives?: Array<{
    path: string;
    raw?: string;
    members?: Array<{ name: string; contents?: string; link?: string }>;
  }>;
  /**
   * Environment variables for this call only.
   *
   * An import fills a credential from the environment when nothing was passed
   * for it, and the name it looks under is the credential's own key —
   * `github_token`, not `GITHUB_TOKEN`. Nothing a fixture can plant on disk
   * reaches that, so a step says it here. Both runtimes are given the same
   * one, and each call is its own process, so it does not leak into the next
   * step.
   */
  env?: Record<string, string>;
}

interface Fixture extends FixtureTree {
  fixtureVersion: 1;
  /** Stub executables planted on PATH, so availability is the fixture's answer. */
  pathStubs: string[];
  plan: Step[];
}

const fixture = JSON.parse(
  await readFile(join(repositoryRoot, "test/fixtures/mcp-profiles-parity-v1.json"), "utf8"),
) as Fixture;
if (fixture.fixtureVersion !== 1) {
  throw new Error(`Unsupported profiles parity fixture version ${fixture.fixtureVersion}`);
}

const specs = [
  // In replay this names a binary that cannot exist, which is what makes "the
  // reference is never started" enforced rather than asserted.
  referenceSpec(),
  ...(probe ? [] : [{ label: "candidate", command: candidateArgv[0], args: candidateArgv.slice(1) }]),
];

const roots: string[] = [];
try {
  const runtimes: Runtime[] = [];
  for (const spec of specs) {
    const runtime = await prepareRuntime(spec, fixture, roots);
    // The agent commands the fixture says are installed, and nothing else:
    // `bin` comes first so a real `claude` on this machine cannot win, and the
    // login shell is neutralised because a stub reachable only through PATH
    // loses to whatever `$SHELL -lc` would put ahead of it.
    runtime.env.PATH = `${join(runtime.home, "bin")}:${process.env.PATH ?? ""}`;
    runtime.env.SHELL = "/bin/sh";
    // A step that passes no cwd falls back to the server's own, which is this
    // checkout — so the "all" steps do answer partly from the machine the gate
    // runs on. That is safe here because nothing is compared against a stored
    // payload: both runtimes are spawned in the same directory and diffed
    // against each other, so a skill installed here changes what is covered,
    // never whether the gate passes. It cannot be pointed elsewhere anyway;
    // the reference is `--import tsx src/index.ts`, which only resolves from
    // the repository root.
    runtimes.push(runtime);
  }

  for (const step of fixture.plan) {
    for (const runtime of runtimes) {
      for (const file of step.removeHomeFiles ?? []) {
        await rm(join(runtime.home, file), { recursive: true, force: true });
      }
      for (const file of step.writeHomeFiles ?? []) {
        const target = join(runtime.home, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, substitute(file.contents, runtime) as string);
      }
      for (const archive of step.writeHomeArchives ?? []) {
        const target = join(runtime.home, archive.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await buildArchive(archive, runtime));
      }
    }
    const observed = await Promise.all(runtimes.map((runtime) => call(runtime, step)));
    for (const runtime of runtimes) await pruneBackups(runtime.home);
    if (dump || probe) {
      for (const [index, entry] of observed.entries()) {
        console.log(`\n--- ${step.id} [${runtimes[index].label}]`);
        console.log(JSON.stringify(entry, null, 2));
      }
    }
    if (probe) continue;
    try {
      assert.deepStrictEqual(observed[1], observed[0]);
      // And again in wire order. Every MCP server map here is reported in the
      // order its config file wrote it, and `deepStrictEqual` compares objects
      // as unordered — so a candidate that sorted these would pass the check
      // above while answering something the reference never says.
      //
      // Only this gate asks that, on purpose. Elsewhere an object's keys are
      // its *fields*, and Rust and TypeScript order those differently for no
      // observable reason. Here the keys are the user's own server names, so
      // their order is data.
      assert.strictEqual(JSON.stringify(observed[1]), JSON.stringify(observed[0]));
    } catch (error) {
      console.error(`\nProfile parity failed at step "${step.id}" (${step.tool}).`);
      console.error(`reference: ${JSON.stringify(observed[0], null, 2)}`);
      console.error(`candidate: ${JSON.stringify(observed[1], null, 2)}`);
      throw error;
    }
  }
  if (!probe) {
    // The gate compares what each tool *said*. A profile is a directory tree,
    // and two runtimes that answered identically can still have built a
    // different one — so the trees are compared too, once every step has run.
    await assertTreesMatch(runtimes);
  }
  if (probe && process.env.NOMOREIDE_DUMP_HOME) {
    // The profile store the tools built up, which no payload shows in full.
    const root = join(runtimes[0].home, ".config/nomoreide/agent-profiles");
    for (const [key, body] of Object.entries(await readTree(root, runtimes[0]))) {
      console.log(`\n=== ${key}`);
      console.log(body);
    }
  }
  console.log(
    probe
      ? `Profile probe finished (${fixture.plan.length} steps against the reference only).`
      : `MCP agent-profile parity passed (${fixture.plan.length} steps).`,
  );
} finally {
  await recorder.finish();
  await Promise.all(
    roots.map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}),
    ),
  );
}

/**
 * One step's answer, from a process or from the recording.
 *
 * The normalized payload is the recorded unit rather than the raw response:
 * it has already had this runtime's own throwaway paths rewritten to fixture
 * tokens, so it is the same value in whatever directory the gate next runs in.
 */
async function call(runtime: Runtime, step: Step): Promise<unknown> {
  return recorder.recorded(recordable(runtime), step.id, async () => {
    const args = Object.fromEntries(
      Object.entries(step.arguments).map(([key, value]) => [key, substitute(value, runtime)]),
    );
    const command = mcpCommand(runtime);
    const response = await callMcpTool(
      step.env ? { ...command, env: { ...command.env, ...step.env } } : command,
      step.tool,
      args,
    );
    return maskBackupStamps(normalize(response, runtime));
  });
}

/**
 * Blank the timestamp out of every backup path.
 *
 * A backup is named for the second it was taken in, with a counter appended
 * when one second holds more than one. Two runtimes are asked the same
 * question milliseconds apart, so which side of a second boundary each lands
 * on — and therefore whether it collides with its own previous backup — is a
 * race, not a behaviour. The *number* of backups a change takes is still
 * compared, because the array keeps its length; the format of the stamp and
 * the collision counter are pinned by unit tests instead.
 */
function maskBackupStamps(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\d{8}-\d{6}(-\d+)?/g, "<stamp>")
      // An archive is unpacked into a directory named for the moment it was
      // unpacked, and a message naming a file that was not in it quotes that
      // path. Which directory it happened to be is not behaviour.
      .replace(/nomoreide-profile-(import|export)-[A-Za-z0-9]+/g, "nomoreide-profile-$1-<tmp>")
      // `updatedAt` is when a profile was last written, so the two runtimes
      // never agree on it. The *order* it puts a listing in is still compared,
      // because masking the value does not reorder the list.
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "<iso-instant>");
  }
  if (Array.isArray(value)) {
    return value.map(maskBackupStamps);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, maskBackupStamps(entry)]),
  );
}

/**
 * Every file both runtimes wrote, compared byte for byte.
 *
 * The two homes and the two repositories hold the same fixture, so after the
 * same plan they must hold the same bytes — modulo each runtime's own paths
 * and the backup stamps, which are rewritten the way a payload's are.
 */
async function assertTreesMatch(runtimes: Runtime[]): Promise<void> {
  const [reference, candidate] = runtimes;
  for (const [label, of] of [
    ["home", (runtime: Runtime) => runtime.home],
    ["repository", (runtime: Runtime) => runtime.paths.get("repo:demo") ?? ""],
  ] as const) {
    // What the reference left on disk is an observation like any other: in
    // replay it comes from the recording, because the tree it would have
    // written was never written.
    const left = await recorder.recorded(recordable(reference), `tree/${label}`, () =>
      readTree(of(reference), reference),
    );
    const right = await readTree(of(candidate), candidate);
    try {
      assert.deepStrictEqual(right, left);
    } catch (error) {
      console.error(`\nThe two runtimes wrote different files under the ${label}.`);
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (left[key] !== right[key]) {
          console.error(`\n--- ${key}`);
          console.error(`reference: ${JSON.stringify(left[key])}`);
          console.error(`candidate: ${JSON.stringify(right[key])}`);
        }
      }
      throw error;
    }
  }
}

async function readTree(root: string, runtime: Runtime): Promise<Record<string, string>> {
  const { readdir } = await import("node:fs/promises");
  const rewrite = rewritePaths(runtime);
  const files: Record<string, string> = {};
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
          // `.git` is the fixture's own bookkeeping, and its object names differ
      // between two runs. `.nomoreide` is the *server's* — session records it
      // writes whatever tool was called — and nothing here owns it.
      if (entry.name === ".git" || entry.name === ".nomoreide") continue;
      // A backup file is not compared here. Its name carries the second it was
      // taken in, so every backup of one file collapses onto a single key and
      // which one's bytes land there is decided by how many the run made and
      // in what order they were read — a measurement of the machine, not of
      // either runtime. What was backed up, and where, is asserted where it is
      // stable: in the answer of the step that made it.
      if (entry.name.includes(".bak.")) continue;
      const path = join(directory, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path, key);
      } else if (entry.name.endsWith(".tar.gz")) {
        // Two gzip implementations do not produce the same bytes for the same
        // input, and they are not meant to — what has to match is what comes
        // back out. So an archive is expanded and each member compared, which
        // also catches a member the other side did not write at all.
        for (const [member, body] of Object.entries(await readArchive(path))) {
          files[`${key}!/${member}`] = rewrite(body);
        }
      } else {
        const body = await readFile(path, "utf8").catch(() => "<unreadable>");
        // A skill set aside as a *directory* is still compared: the stamp in
        // its name is a race, so the name is normalised, and the bytes inside
        // it have to match.
        files[key.replace(/\d{8}-\d{6}(-\d+)?/g, "<stamp>")] = rewrite(body);
      }
    }
  };
  await walk(root, "");
  return files;
}

/**
 * Every file inside a `.tar.gz`, by member path.
 *
 * Shelling out to `tar` rather than reading the format here: both runtimes
 * wrote a real archive, and the question is whether a third party can get the
 * same files out of either.
 */
async function readArchive(path: string): Promise<Record<string, string>> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const run = promisify(execFile);
  const into = await mkdtemp(join(tmpdir(), "nomoreide-parity-archive-"));
  try {
    await run("tar", ["xzf", path, "-C", into]);
    const files: Record<string, string> = {};
    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name);
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(child, key);
        else files[key] = await readFile(child, "utf8").catch(() => "<unreadable>");
      }
    };
    await walk(into, "");
    return files;
  } catch {
    return { "<unreadable>": "the archive could not be expanded" };
  } finally {
    await rm(into, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Pack an archive by hand, header by header.
 *
 * Not `tar(1)`: the point of some of these is a member path a packer refuses
 * to write — `../escape`, or an absolute one — and that is exactly what an
 * importer has to defend against. Writing the 512-byte headers directly is the
 * only way to hand it one.
 */
async function buildArchive(
  archive: { raw?: string; members?: Array<{ name: string; contents?: string; link?: string }> },
  runtime: Runtime,
): Promise<Buffer> {
  if (archive.raw !== undefined) {
    return Buffer.from(substitute(archive.raw, runtime) as string);
  }
  const { gzipSync } = await import("node:zlib");
  const blocks: Buffer[] = [];
  for (const member of archive.members ?? []) {
    const body = member.link
      ? Buffer.alloc(0)
      : Buffer.from(substitute(member.contents ?? "", runtime) as string);
    const header = Buffer.alloc(512);
    header.write(member.name, 0, 100, "utf8");
    header.write("000644 \0", 100, 8, "utf8"); // mode
    header.write("000000 \0", 108, 8, "utf8"); // uid
    header.write("000000 \0", 116, 8, "utf8"); // gid
    header.write(`${body.length.toString(8).padStart(11, "0")} `, 124, 12, "utf8");
    header.write("00000000000 ", 136, 12, "utf8"); // mtime, fixed so two runs agree
    header.write("        ", 148, 8, "utf8"); // checksum, blanks while computing
    // A regular file unless the member is a link, which is the one member
    // type an importer has to refuse: a link pointing out of the directory
    // turns every later member into a write wherever it points.
    header.write(member.link ? "2" : "0", 156, 1, "utf8");
    if (member.link) header.write(member.link, 157, 100, "utf8");
    header.write("ustar\0" + "00", 257, 8, "utf8");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024)); // the two empty blocks that end an archive
  return gzipSync(Buffer.concat(blocks));
}
