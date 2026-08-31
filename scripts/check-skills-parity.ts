/**
 * Phase 6 parity gate for the one-time-skill endpoints:
 *
 *   GET  /api/skills/search
 *   POST /api/skills/use
 *
 * **Only the refusals are gated, and that is deliberate.** Both endpoints end
 * in something this gate must not do: a search reaches `skills.sh`, and using a
 * skill shells out to fetch a repository. The base URL is a constant with no
 * override, so a stub cannot be put in front of it — which leaves the success
 * paths out of reach here, and they are recorded as such rather than faked with
 * a case that would quietly make a network call from a test.
 *
 * What is left is the half that matters most anyway. `validateOneTimeSkill` is
 * what stands between a client-supplied string and a `git` invocation, so every
 * case below is a source this must refuse: no separator, a separator at the
 * front, a repository or selector that starts with punctuation, a selector with
 * a path in it, and one too long. A port that let any of them through would be
 * a port that fetches what a page told it to.
 *
 * **Two behaviours are provably out of reach here**, and are unit-tested in the
 * core instead rather than being claimed. Which end of the source the separator
 * splits at cannot be seen: `@` belongs to neither the repository charset nor
 * the selector charset, so a source with two of them is refused whichever way
 * it splits, and the only input that would tell them apart is one where a split
 * *succeeds* -- which reaches a subprocess. And the core's own two-hundred-unit
 * name limit is unreachable through HTTP at all, because the schema below caps
 * a name at two hundred units before the validator ever sees it.
 *
 * The two refusals are also different refusals, and the gate keeps them apart:
 * a body the schema rejects is a 400 that never reaches the validator, and a
 * body it accepts whose source is invalid is a 422 from the validator itself.
 *
 * Usage:
 *   node --import tsx scripts/check-skills-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    "Usage: node --import tsx scripts/check-skills-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  /** Sent verbatim, for bodies that are not valid JSON. */
  readonly raw?: string;
}

const use = (skill: unknown, extra: Record<string, unknown> = {}) => ({ skill, ...extra });
const SEARCH = "/api/skills/search";
const USE = "/api/skills/use";

/** A source that would pass, used only where something *else* must fail. */
const GOOD_SOURCE = "owner/repo@some-skill";

const steps: Step[] = [
  // --- search: the query is checked before anything is fetched ---------------
  { name: "search/no-query-at-all", method: "GET", path: SEARCH },
  { name: "search/an-empty-query", method: "GET", path: `${SEARCH}?q=` },
  { name: "search/one-character", method: "GET", path: `${SEARCH}?q=a` },
  // Trimmed to one character, so the trim happens before the length check.
  { name: "search/whitespace-around-one-character", method: "GET", path: `${SEARCH}?q=%20%20a%20%20` },
  { name: "search/one-hundred-and-one-characters", method: "GET", path: `${SEARCH}?q=${"x".repeat(101)}` },
  { name: "search/a-repeated-query-parameter", method: "GET", path: `${SEARCH}?q=a&q=abcdef` },
  // One character, three bytes. Counting bytes rather than UTF-16 units would
  // let this through and put a request on the network.
  { name: "search/one-wide-character", method: "GET", path: `${SEARCH}?q=${encodeURIComponent("\u4e2d")}` },
  {
    name: "search/one-hundred-and-one-wide-characters",
    method: "GET",
    path: `${SEARCH}?q=${encodeURIComponent("\u4e2d".repeat(101))}`,
  },
  { name: "search/an-unrelated-parameter", method: "GET", path: `${SEARCH}?limit=1` },

  // --- use: bodies the schema refuses, which never reach the validator -------
  { name: "use/an-empty-body", method: "POST", path: USE, body: {} },
  { name: "use/a-body-that-is-not-an-object", method: "POST", path: USE, body: [1, 2] },
  { name: "use/a-body-that-is-not-json", method: "POST", path: USE, raw: "{ not json" },
  { name: "use/no-body-at-all", method: "POST", path: USE },
  { name: "use/an-empty-skill", method: "POST", path: USE, body: use({}) },
  { name: "use/a-skill-with-no-source", method: "POST", path: USE, body: use({ name: "x" }) },
  { name: "use/a-skill-with-no-name", method: "POST", path: USE, body: use({ source: GOOD_SOURCE }) },
  { name: "use/a-name-that-is-only-spaces", method: "POST", path: USE, body: use({ name: "   ", source: GOOD_SOURCE }) },
  { name: "use/a-name-past-two-hundred", method: "POST", path: USE, body: use({ name: "n".repeat(201), source: GOOD_SOURCE }) },
  // Two hundred and one wide characters: over the limit by units, well over by
  // bytes, and the refusal has to come from the units.
  { name: "use/a-wide-name-past-two-hundred", method: "POST", path: USE, body: use({ name: "\u4e2d".repeat(201), source: GOOD_SOURCE }) },
  // Inside the limit by units and outside it by bytes, so a byte count would
  // refuse this at the schema (400) where the reference lets it through to the
  // validator, which refuses the source instead (422). The two refusals are
  // what tells the counts apart.
  {
    name: "use/a-wide-name-within-the-limit",
    method: "POST",
    path: USE,
    body: use({ name: "\u4e2d".repeat(100), source: "owner/repo" }),
  },
  {
    name: "use/a-wide-source-within-the-limit",
    method: "POST",
    path: USE,
    body: use({ name: "x", source: "\u4e2d".repeat(150) }),
  },
  { name: "use/a-source-under-three-characters", method: "POST", path: USE, body: use({ name: "x", source: "ab" }) },
  { name: "use/a-source-past-four-hundred", method: "POST", path: USE, body: use({ name: "x", source: `o/r@${"s".repeat(400)}` }) },
  { name: "use/a-name-that-is-not-a-string", method: "POST", path: USE, body: use({ name: 7, source: GOOD_SOURCE }) },
  { name: "use/an-extra-key-on-the-skill", method: "POST", path: USE, body: use({ name: "x", source: GOOD_SOURCE, extra: 1 }) },
  { name: "use/an-extra-key-on-the-body", method: "POST", path: USE, body: use({ name: "x", source: GOOD_SOURCE }, { extra: 1 }) },

  // --- use: bodies the schema accepts and the validator refuses --------------
  { name: "use/a-source-with-no-separator", method: "POST", path: USE, body: use({ name: "x", source: "owner/repo" }) },
  // The separator has to be *past* the front, so a leading one is not one.
  { name: "use/a-source-that-starts-with-the-separator", method: "POST", path: USE, body: use({ name: "x", source: "@some-skill" }) },
  { name: "use/a-repository-that-starts-with-punctuation", method: "POST", path: USE, body: use({ name: "x", source: "-owner/repo@s" }) },
  { name: "use/a-repository-with-no-slash", method: "POST", path: USE, body: use({ name: "x", source: "ownerrepo@s" }) },
  { name: "use/a-repository-with-two-slashes", method: "POST", path: USE, body: use({ name: "x", source: "owner/repo/deep@s" }) },
  { name: "use/a-selector-that-starts-with-punctuation", method: "POST", path: USE, body: use({ name: "x", source: "owner/repo@-skill" }) },
  { name: "use/a-selector-with-a-path-in-it", method: "POST", path: USE, body: use({ name: "x", source: "owner/repo@skills/one" }) },
  { name: "use/a-selector-past-two-hundred", method: "POST", path: USE, body: use({ name: "x", source: `owner/repo@s${"e".repeat(200)}` }) },
  // The *last* separator splits, so an inner one belongs to the repository --
  // and a repository may not contain one, which is why this is refused.
  { name: "use/two-separators", method: "POST", path: USE, body: use({ name: "x", source: "owner@inner/repo@s" }) },

  // --- shape ------------------------------------------------------------------
  { name: "shape/search-rejects-post", method: "POST", path: SEARCH },
  { name: "shape/use-rejects-get", method: "GET", path: USE },
  { name: "shape/a-trailing-slash", method: "GET", path: `${SEARCH}/` },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

const credentials = new Map<Runtime, string>();

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const credential = credentials.get(runtime) ?? "";
  const headers: Record<string, string> = credential
    ? { authorization: `Bearer ${credential}` }
    : {};
  let body: string | undefined;
  if (step.raw !== undefined) {
    body = step.raw;
    headers["content-type"] = "application/json";
  } else if (step.body !== undefined) {
    body = JSON.stringify(step.body);
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers,
    body,
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

const root = await mkdtemp(join(tmpdir(), "nmi-skills-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({ version: 1, services: [], bundles: [], databases: [], gitRepositories: [] }),
      () => [],
    );
    await harness.startDaemon(runtime);
    credentials.set(
      runtime,
      await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
        .then((value) => value.trim())
        .catch(() => ""),
    );
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
      assert.deepStrictEqual(answers.candidate, answers.reference);
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
  console.log(`\nskills parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nskills parity: ${steps.length} cases match`);
