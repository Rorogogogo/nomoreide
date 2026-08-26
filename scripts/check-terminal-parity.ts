/**
 * Phase 6 parity gate for the terminal tab surface:
 *
 *   GET    /api/terminal/capabilities
 *   GET    /api/terminal/transcripts
 *   GET    /api/terminal/sessions
 *   POST   /api/terminal/sessions
 *   PATCH  /api/terminal/sessions/:id            (rename)
 *   DELETE /api/terminal/sessions/:id            (close)
 *   POST   /api/terminal/sessions/:id/open-system-terminal
 *   POST   /api/terminal/sessions/:id/reclaim-dock
 *   POST   /api/terminal/sessions/:id/insert-prompt
 *
 * (`/api/terminal/events` is Server-Sent Events and `/api/terminal/socket` is
 * the PTY stream itself; neither is served natively yet.)
 *
 * Four of these were already served and none of them had ever been gated — the
 * existing `check-mcp-terminal-parity.ts` drives the MCP tools, which re-project
 * the fields, so the HTTP shapes are unverified.
 *
 * **A header guards the three action routes.** Without
 * `x-nomoreide-terminal-control: 1` they are a 403, decided *before* the id is
 * looked at, so a bad id and a missing header is a 403 rather than a 400.
 *
 * **There are two id rules, not one.** The action routes decode with a schema
 * that also refuses `/` and `\` and caps the id at 200 characters; the rename
 * and close route uses a laxer one that only refuses control characters and
 * allows 1000. A case that passes one and fails the other is the point.
 *
 * **A prompt is measured three times.** The body has a byte cap that answers
 * 413; the parsed prompt is measured again in UTF-8 bytes, also 413; and the
 * paste encoder refuses a prompt carrying a submit character with its own
 * wording as a 400.
 *
 * **404 or 409 is decided by the message**, not by the failure: both action
 * routes branch on whether it starts with `Unknown terminal session:`.
 *
 * A session's identity is not stable between two runtimes — pids and timestamps
 * differ — so those keys are redacted, and cases name a session by the label it
 * was created with rather than by its id.
 *
 * Usage:
 *   node --import tsx scripts/check-terminal-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
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
    "Usage: node --import tsx scripts/check-terminal-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** `{{ID}}` is replaced with the id resolved from `idOfIndex`. */
  readonly path: string;
  readonly body?: string;
  /** Send the terminal-control header. */
  readonly control?: true;
  /**
   * Which session `{{ID}}` means, by its position in the listing.
   *
   * Not by label: `POST /api/terminal/sessions` ignores a top-level `label`
   * entirely — only an agent session takes one — so a shell opened here has no
   * label to find it by until a rename gives it one. And not by id: both
   * runtimes happen to number sessions `term_<n>` off the same counter, but
   * that is a coincidence of two implementations rather than a contract, and a
   * gate leaning on it would be asserting the wrong thing. Both listings are
   * insertion-ordered, which *is* the contract.
   */
  readonly idOfIndex?: number;
}

const SESSIONS = "/api/terminal/sessions";
/**
 * The three sizes a prompt is measured against, and they are three different
 * numbers. `MAX_AGENT_PROMPT_BYTES` is 512KiB; the *body* cap is six times that
 * plus a kilobyte, because a prompt of multi-byte characters JSON-escapes to
 * several bytes each. So a prompt can be over the prompt cap while the body is
 * comfortably under the body cap, and both answer 413 from different places.
 */
const PROMPT_CAP = 512 * 1024;
const BODY_CAP = PROMPT_CAP * 6 + 1_024;
/** Over the prompt cap, well under the body cap. */
const OVER_THE_PROMPT_CAP = "x".repeat(PROMPT_CAP + 1);
/** Over the body cap, so the reader stops before anything is parsed. */
const OVER_THE_BODY_CAP = "x".repeat(BODY_CAP + 1_000);
/**
 * Under the cap counted in characters and over it counted in UTF-8 bytes — the
 * cap is `Buffer.byteLength`, not `.length`.
 */
const MULTIBYTE_OVER_THE_CAP = "é".repeat(PROMPT_CAP / 2 + 1);

const steps: readonly Step[] = [
  // --- what the host can do --------------------------------------------------
  // Not wrapped in an `ok` envelope, unlike everything else here.
  { name: "capabilities/read", method: "GET", path: "/api/terminal/capabilities" },
  { name: "capabilities/wrong-method", method: "POST", path: "/api/terminal/capabilities" },

  // --- transcripts -----------------------------------------------------------
  // Scoped, this answers with the *stale worktree's* one session and nothing
  // else: the route reads `activeWorktreePath` without checking that it is a
  // worktree, so the workspace's own sessions are out of scope.
  { name: "transcripts/the-selected-repository", method: "GET", path: "/api/terminal/transcripts" },
  // Unscoped, everything with a title, newest written first — which exercises
  // the sidechain skip, the injected-context skip, the duplicate session id,
  // the lossy directory match, and the Codex subagent drop all at once.
  { name: "transcripts/every-scope", method: "GET", path: "/api/terminal/transcripts?scope=all" },
  // Only the exact string `all` widens the scope.
  { name: "transcripts/an-unknown-scope", method: "GET", path: "/api/terminal/transcripts?scope=ALL" },
  { name: "transcripts/a-blank-scope", method: "GET", path: "/api/terminal/transcripts?scope=" },
  // A repeated parameter is the first one, not the last and not a join.
  { name: "transcripts/a-repeated-scope", method: "GET", path: "/api/terminal/transcripts?scope=all&scope=mine" },
  { name: "transcripts/a-scope-among-others", method: "GET", path: "/api/terminal/transcripts?limit=1&scope=all" },
  { name: "transcripts/wrong-method", method: "POST", path: "/api/terminal/transcripts" },

  // --- listing and opening ---------------------------------------------------
  { name: "sessions/empty", method: "GET", path: SESSIONS },
  // A top-level `label` is ignored — only an agent session carries one — so
  // this opens an unlabelled shell whatever it asks for.
  { name: "sessions/open-a-shell", method: "POST", path: SESSIONS, body: '{"label":"first"}' },
  { name: "sessions/open-with-no-body", method: "POST", path: SESSIONS },
  { name: "sessions/open-with-a-blank-label", method: "POST", path: SESSIONS, body: '{"label":"   "}' },
  { name: "sessions/open-with-a-long-label", method: "POST", path: SESSIONS, body: `{"label":"${"l".repeat(120)}"}` },
  { name: "sessions/the-listing", method: "GET", path: SESSIONS },

  // --- an agent session, refused before anything is spawned ------------------
  { name: "agent/an-unknown-provider", method: "POST", path: SESSIONS, body: '{"agent":{"provider":"gemini","prompt":""}}' },
  { name: "agent/a-resume-id-that-is-not-a-uuid", method: "POST", path: SESSIONS, body: '{"agent":{"provider":"codex","resumeId":"nope"}}' },
  { name: "agent/an-empty-agent-object", method: "POST", path: SESSIONS, body: '{"agent":{}}' },
  { name: "agent/an-agent-that-is-a-string", method: "POST", path: SESSIONS, body: '{"agent":"codex"}' },
  { name: "agent/an-unknown-key", method: "POST", path: SESSIONS, body: '{"agent":{"provider":"codex","colour":"red"}}' },
  { name: "agent/a-model-that-is-blank", method: "POST", path: SESSIONS, body: '{"agent":{"provider":"codex","model":"  "}}' },
  { name: "agent/a-one-time-skill-with-a-short-source", method: "POST", path: SESSIONS, body: '{"agent":{"provider":"codex","oneTimeSkill":{"name":"x","source":"ab"}}}' },
  { name: "agent/a-context-ref-of-an-unknown-kind", method: "POST", path: SESSIONS, body: '{"agent":{"provider":"codex","context":{"refs":[{"kind":"widget","id":"a"}],"includePinned":false}}}' },

  // --- relabelling -----------------------------------------------------------
  { name: "rename/a-session", method: "PATCH", path: `${SESSIONS}/{{ID}}`, body: '{"label":"  renamed  "}', idOfIndex: 0 },
  // Without this the rename is only ever checked through its own answer.
  { name: "rename/the-listing-afterwards", method: "GET", path: SESSIONS },
  { name: "rename/a-blank-label", method: "PATCH", path: `${SESSIONS}/{{ID}}`, body: '{"label":"   "}', idOfIndex: 0 },
  { name: "rename/a-label-that-is-too-long", method: "PATCH", path: `${SESSIONS}/{{ID}}`, body: `{"label":"${"n".repeat(61)}"}`, idOfIndex: 0 },
  { name: "rename/an-unknown-key", method: "PATCH", path: `${SESSIONS}/{{ID}}`, body: '{"label":"ok","colour":"red"}', idOfIndex: 0 },
  { name: "rename/no-body", method: "PATCH", path: `${SESSIONS}/{{ID}}`, idOfIndex: 0 },
  { name: "rename/an-unknown-session", method: "PATCH", path: `${SESSIONS}/term_999`, body: '{"label":"ok"}' },
  // The laxer id rule: a slash is allowed here (it is a *path* segment, so it
  // arrives encoded), and a control character is not.
  { name: "rename/an-id-with-a-slash", method: "PATCH", path: `${SESSIONS}/a%2Fb`, body: '{"label":"ok"}' },
  { name: "rename/an-id-with-a-control-character", method: "PATCH", path: `${SESSIONS}/a%01b`, body: '{"label":"ok"}' },
  { name: "rename/an-id-that-is-badly-encoded", method: "PATCH", path: `${SESSIONS}/a%zzb`, body: '{"label":"ok"}' },
  { name: "rename/wrong-method", method: "PUT", path: `${SESSIONS}/term_999` },

  // --- inserting a prompt ----------------------------------------------------
  // The header is checked first, so this is a 403 and not a 404.
  { name: "insert/without-the-header", method: "POST", path: `${SESSIONS}/term_999/insert-prompt`, body: '{"prompt":"hi"}' },
  { name: "insert/an-unknown-session", method: "POST", path: `${SESSIONS}/term_999/insert-prompt`, body: '{"prompt":"hi"}', control: true },
  { name: "insert/an-empty-prompt", method: "POST", path: `${SESSIONS}/{{ID}}/insert-prompt`, body: '{"prompt":""}', control: true, idOfIndex: 0 },
  { name: "insert/no-prompt", method: "POST", path: `${SESSIONS}/{{ID}}/insert-prompt`, body: "{}", control: true, idOfIndex: 0 },
  { name: "insert/an-unknown-key", method: "POST", path: `${SESSIONS}/{{ID}}/insert-prompt`, body: '{"prompt":"hi","colour":"red"}', control: true, idOfIndex: 0 },
  // A carriage return would submit the prompt rather than paste it.
  { name: "insert/a-prompt-that-submits", method: "POST", path: `${SESSIONS}/{{ID}}/insert-prompt`, body: '{"prompt":"do it\\r"}', control: true, idOfIndex: 0 },
  { name: "insert/a-prompt-with-a-newline", method: "POST", path: `${SESSIONS}/{{ID}}/insert-prompt`, body: '{"prompt":"one\\ntwo"}', control: true, idOfIndex: 0 },
  // Over the *body* cap, so the reader stops before anything is parsed.
  { name: "insert/a-body-over-the-body-cap", method: "POST", path: `${SESSIONS}/{{ID}}/insert-prompt`, body: `{"prompt":"${OVER_THE_BODY_CAP}"}`, control: true, idOfIndex: 0 },
  // Parsed fine, then refused by the second measurement — same status, and the
  // same wording, from a different check.
  { name: "insert/a-prompt-over-the-prompt-cap", method: "POST", path: `${SESSIONS}/{{ID}}/insert-prompt`, body: `{"prompt":"${OVER_THE_PROMPT_CAP}"}`, control: true, idOfIndex: 0 },
  // Half as many characters as the cap, and one byte over it.
  { name: "insert/a-prompt-that-is-multibyte", method: "POST", path: `${SESSIONS}/{{ID}}/insert-prompt`, body: `{"prompt":"${MULTIBYTE_OVER_THE_CAP}"}`, control: true, idOfIndex: 0 },
  { name: "insert/a-prompt", method: "POST", path: `${SESSIONS}/{{ID}}/insert-prompt`, body: '{"prompt":"review this"}', control: true, idOfIndex: 0 },
  // The stricter id rule: a slash is refused here even though rename allows it.
  { name: "insert/an-id-with-a-slash", method: "POST", path: `${SESSIONS}/a%2Fb/insert-prompt`, body: '{"prompt":"hi"}', control: true },
  { name: "insert/an-id-that-is-badly-encoded", method: "POST", path: `${SESSIONS}/a%zzb/insert-prompt`, body: '{"prompt":"hi"}', control: true },
  { name: "insert/wrong-method", method: "GET", path: `${SESSIONS}/term_999/insert-prompt`, control: true },

  // --- the other two actions -------------------------------------------------
  { name: "reclaim/without-the-header", method: "POST", path: `${SESSIONS}/term_999/reclaim-dock` },
  { name: "reclaim/an-unknown-session", method: "POST", path: `${SESSIONS}/term_999/reclaim-dock`, control: true },
  { name: "reclaim/a-session", method: "POST", path: `${SESSIONS}/{{ID}}/reclaim-dock`, control: true, idOfIndex: 0 },
  { name: "reclaim/wrong-method", method: "DELETE", path: `${SESSIONS}/term_999/reclaim-dock`, control: true },
  { name: "system-terminal/wrong-method", method: "GET", path: `${SESSIONS}/term_999/open-system-terminal`, control: true },
  { name: "system-terminal/without-the-header", method: "POST", path: `${SESSIONS}/term_999/open-system-terminal` },
  { name: "system-terminal/an-unknown-session", method: "POST", path: `${SESSIONS}/term_999/open-system-terminal`, control: true },
  { name: "action/an-unknown-action", method: "POST", path: `${SESSIONS}/term_999/detonate`, control: true },

  // --- closing ---------------------------------------------------------------
  // `ok` reports whether anything closed, and the status stays 200 either way.
  { name: "close/an-unknown-session", method: "DELETE", path: `${SESSIONS}/term_999` },
  { name: "close/a-session", method: "DELETE", path: `${SESSIONS}/{{ID}}`, idOfIndex: 0 },
  { name: "close/the-same-session-again", method: "DELETE", path: `${SESSIONS}/term_1` },
  { name: "close/the-listing-afterwards", method: "GET", path: SESSIONS },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

const CONTROL_HEADER = "x-nomoreide-terminal-control";

async function credentialFor(runtime: Runtime): Promise<Record<string, string>> {
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  return credential ? { authorization: `Bearer ${credential}` } : {};
}

/** The id a step means, resolved against this runtime's own sessions. */
async function resolveId(runtime: Runtime, index: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${SESSIONS}`, {
    headers: await credentialFor(runtime),
  });
  const payload = (await response.json()) as { sessions?: Array<{ id: string }> };
  return payload.sessions?.[index]?.id ?? "term_missing";
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  let path = step.path;
  if (step.idOfIndex !== undefined) {
    path = path.split("{{ID}}").join(encodeURIComponent(await resolveId(runtime, step.idOfIndex)));
  }
  const headers: Record<string, string> = {
    ...(await credentialFor(runtime)),
    "content-type": "application/json",
    ...(step.control ? { [CONTROL_HEADER]: "1" } : {}),
  };
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: step.method,
    headers,
    body: step.method === "GET" ? undefined : step.body,
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

/** Keys whose value says *when* or *which process*, not *what*. */
const VOLATILE = new Set(["pid", "createdAt", "updatedAt", "startedAt", "lastActiveAt", "id"]);

/**
 * A terminal session's id is assigned per runtime and says nothing; a
 * transcript's id is the thing `--resume` takes, so it is compared. They are
 * told apart by the object they sit in — only a transcript carries a `title`.
 */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const isTranscript = entries.some(([key]) => key === "title");
    return Object.fromEntries(
      entries.map(([key, item]) =>
        VOLATILE.has(key) && !(isTranscript && key === "id")
          ? [key, "<volatile>"]
          : [key, scrub(item)],
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
    .join("<home>");
  return { ...answer, body: scrub(JSON.parse(erased)) };
}

/**
 * Transcript fixtures.
 *
 * The listing is read from `$HOME/.claude/projects` and `$CODEX_HOME/sessions`,
 * so these are planted **above** the workspace — `provision` joins a file's path
 * onto the workspace, and `../` from there is the runtime's own home.
 *
 * Claude buckets a session under a directory named for the cwd it ran in, but
 * the encoding has changed between releases, so the reader compares directory
 * names *lossily* (every run of non-alphanumerics is one separator) and then
 * confirms each candidate against the `cwd` recorded in its own body. Both
 * halves of that are fixtures here: `<dir>-` keys the same as `<dir>`, and one
 * file sits in the right directory while its body names another project.
 */
function claudeDir(path: string): string {
  return path.split("/").join("-");
}

const claudeLine = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;

function claudeSession(
  id: string,
  cwd: string,
  turns: Array<{ text: unknown; sidechain?: true }>,
): string {
  return turns
    .map((turn, index) =>
      claudeLine({
        type: "user",
        sessionId: id,
        cwd,
        timestamp: `2026-07-0${index + 1}T09:00:00.000Z`,
        ...(turn.sidechain ? { isSidechain: true } : {}),
        message: { content: turn.text },
      }),
    )
    .join("");
}

function codexRollout(id: string, cwd: string, prompt: string, subagent = false): string {
  return (
    claudeLine({
      type: "session_meta",
      payload: {
        session_id: id,
        cwd,
        timestamp: "2026-07-01T09:00:00.000Z",
        ...(subagent ? { thread_source: "subagent" } : {}),
      },
    }) +
    claudeLine({
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
    })
  );
}

/**
 * When each transcript was last written, which is the only thing the listing
 * orders by. Two files written in the same millisecond would order by whichever
 * the filesystem happened to stamp first, so every mtime is set explicitly.
 */
const WRITTEN: ReadonlyArray<readonly [string, string]> = [
  [".claude/projects/{{W}}/aaaa-1111.jsonl", "2026-08-01T00:00:00.000Z"],
  [".claude/projects/{{W}}/bbbb-2222.jsonl", "2026-08-02T00:00:00.000Z"],
  [".claude/projects/{{W}}/cccc-3333.jsonl", "2026-08-03T00:00:00.000Z"],
  [".claude/projects/{{W}}/dddd-4444.jsonl", "2026-08-04T00:00:00.000Z"],
  [".claude/projects/{{W}}-/dddd-4444.jsonl", "2026-08-05T00:00:00.000Z"],
  [".claude/projects/{{S}}/ssss-7777.jsonl", "2026-08-06T00:00:00.000Z"],
  [".claude/projects/{{S}}/tttt-8888.jsonl", "2026-08-07T00:00:00.000Z"],
  [".claude/projects/-elsewhere-project/eeee-9999.jsonl", "2026-08-08T00:00:00.000Z"],
  [".codex/sessions/2026/07/01/rollout-2026-07-01T09-00-00-codex-1.jsonl", "2026-08-09T00:00:00.000Z"],
  [".codex/sessions/2026/07/01/rollout-2026-07-01T09-00-00-codex-2.jsonl", "2026-08-10T00:00:00.000Z"],
];

/** The stale worktree: a real directory that was never a git worktree. */
const staleWorktree = (home: string) => join(home, "stale-worktree");

function transcriptFiles(partial: { home: string; workspace: string }) {
  const workspace = partial.workspace;
  const stale = staleWorktree(partial.home);
  const at = (path: string) =>
    `../${path.split("{{W}}").join(claudeDir(workspace)).split("{{S}}").join(claudeDir(stale))}`;
  const contents: Record<string, string> = {
    ".claude/projects/{{W}}/aaaa-1111.jsonl": claudeSession("aaaa-1111", workspace, [
      { text: "the oldest workspace session" },
    ]),
    // The opening turn is a sidechain, which is context the CLI recorded rather
    // than anything a human typed; the title is the turn after it, assembled
    // from typed blocks rather than a plain string.
    ".claude/projects/{{W}}/bbbb-2222.jsonl": claudeSession("bbbb-2222", workspace, [
      { text: "a sidechain turn", sidechain: true },
      { text: [{ type: "text", text: "a real " }, { type: "text", text: "prompt" }] },
    ]),
    // Nothing but injected context, so it never earns a title and is dropped.
    ".claude/projects/{{W}}/cccc-3333.jsonl": claudeSession("cccc-3333", workspace, [
      { text: "<system-reminder>not a prompt</system-reminder>" },
    ]),
    // The same session id written to two directories: only the newer survives.
    ".claude/projects/{{W}}/dddd-4444.jsonl": claudeSession("dddd-4444", workspace, [
      { text: "the older copy" },
    ]),
    ".claude/projects/{{W}}-/dddd-4444.jsonl": claudeSession("dddd-4444", workspace, [
      { text: "the newer copy" },
    ]),
    ".claude/projects/{{S}}/ssss-7777.jsonl": claudeSession("ssss-7777", stale, [
      { text: "a stale worktree session" },
    ]),
    // Right directory, wrong body: the cwd is what decides.
    ".claude/projects/{{S}}/tttt-8888.jsonl": claudeSession("tttt-8888", workspace, [
      { text: "a body that disagrees with its directory" },
    ]),
    ".claude/projects/-elsewhere-project/eeee-9999.jsonl": claudeSession(
      "eeee-9999",
      "/elsewhere/project",
      [{ text: "another project entirely" }],
    ),
    ".codex/sessions/2026/07/01/rollout-2026-07-01T09-00-00-codex-1.jsonl": codexRollout(
      "codex-1111",
      workspace,
      "a codex prompt",
    ),
    ".codex/sessions/2026/07/01/rollout-2026-07-01T09-00-00-codex-2.jsonl": codexRollout(
      "codex-2222",
      workspace,
      "a subagent thread",
      true,
    ),
  };
  return [
    // A directory is enough to make `activeWorktreePath` resolvable without
    // making it a worktree.
    { path: `../stale-worktree/.keep`, contents: "" },
    ...Object.entries(contents).map(([path, body]) => ({ path: at(path), contents: body })),
  ];
}

/** Stamp the mtimes the listing orders by, before either daemon reads them. */
async function stampTranscripts(runtime: Runtime): Promise<void> {
  for (const [path, written] of WRITTEN) {
    const resolved = join(
      runtime.home,
      path.split("{{W}}").join(claudeDir(runtime.workspace)).split("{{S}}").join(claudeDir(staleWorktree(runtime.home))),
    );
    await utimes(resolved, new Date(written), new Date(written));
  }
}

const root = await mkdtemp(join(tmpdir(), "nmi-terminal-parity-"));
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
        // `activeWorktreePath` names a directory that is *not* a worktree. The
        // shared `selectedGitCwd` helper checks that and falls back to `path`;
        // the transcripts route does not, and reads the stale path anyway. A
        // port that reuses the helper here answers with the workspace's
        // sessions instead of the stale one's, which is the whole point of the
        // fixture.
        gitRepositories: [
          {
            name: "demo",
            path: partial.workspace,
            activeWorktreePath: join(partial.home, "stale-worktree"),
          },
        ],
        selectedGitRepository: "demo",
      }),
      transcriptFiles,
    );
    await stampTranscripts(runtime);
    // Codex's home is read from the environment when nothing overrides it, so
    // an installation on the developer's own machine would otherwise leak into
    // the listing.
    await harness.startDaemon(runtime, { CODEX_HOME: join(runtime.home, ".codex") });
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
  console.log(`\nterminal parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nterminal parity: ${steps.length} cases match`);
