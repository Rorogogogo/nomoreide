/**
 * Phase 6 parity gate for GET /api/agent.
 *
 * One endpoint, and the widest surface in the daemon: it reports what both
 * agents have on this machine — instructions, memory, skills, MCP servers,
 * plugins, hooks, and the projects each has seen — plus which agent it thinks
 * it is running under. Every input is a file or an environment variable, so the
 * gate owns all of them.
 *
 * **Detection is fixed at boot, so the gate runs in phases.** `detectAgent`
 * reads the environment of the daemon process, and a daemon's environment
 * cannot be changed once it is up. Each phase therefore stands up its own pair
 * of daemons under its own harness root, with its own environment, and runs its
 * own steps. The first phase carries the bulk of the file cases; the other
 * three exist to reach the three detected identities and the signal list each
 * one builds.
 *
 * **`parentProcess` is the same for both runtimes by construction.** It comes
 * from `ps` against the daemon's parent, and both daemons are spawned by this
 * gate — so it is this process's own command line either way. It is left in the
 * comparison rather than erased: if a port asked a different question of `ps`,
 * or asked it of itself instead of its parent, the answers would differ.
 *
 * **Two orderings in the reference are not total, and the fixtures stay off
 * them.** Claude skills sort by name alone, so two skills of the same name in
 * different scopes fall back to the order concurrent directory reads happened
 * to push them in; and a Codex session tie on `timestamp` resolves to whichever
 * rollout was read last. Neither is a decision this port should be pinned to,
 * so no fixture below produces either tie.
 *
 * Usage:
 *   node --import tsx scripts/check-agent-info-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";
import { gateName } from "../test/support/parity-recording.js";

const argv = process.argv.slice(2).filter((a) => a !== "--dump");
const dump = process.argv.slice(2).includes("--dump");
if (argv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-agent-info-parity.ts [--dump] <candidate> [args...]",
  );
}

const EPOCH = 1_700_000_000;

// --- fixture builders ---------------------------------------------------------

function skill(description: string | null): string {
  const front = description === null ? "" : `description: ${description}\n`;
  return `---\nname: ignored\n${front}---\n\n# A skill\n\nBody text.\n`;
}

/**
 * `~/.claude.json`. The MCP entries cover every field `mcpEntry` copies and
 * every shape it refuses: a non-string command, an `args` array with a number
 * in it, and a server that is not an object at all.
 */
function claudeJson(workspace: string): string {
  const projects: Record<string, unknown> = {
    [workspace]: {
      mcpServers: { "proj-b": { command: "b" }, "proj-a": { type: "sse", url: "https://a" } },
      lastSessionFirstPrompt: "the current one",
      lastSessionModified: "2026-08-01T00:00:00.000Z",
    },
    // Same instant as /zeta below, so the basename tiebreak decides.
    "/alpha": { lastSessionModified: "2026-08-03T00:00:00.000Z", mcpServers: { a: {}, b: {} } },
    "/zeta": { lastSessionModified: "2026-08-03T00:00:00.000Z" },
    "/newest": { lastSessionModified: "2026-08-09T00:00:00.000Z" },
    // Same instant, and basenames that order the opposite way to the paths:
    // by basename `aaa` leads, by whole path `/a/zzz` would.
    "/z/aaa": { lastSessionModified: "2026-08-04T00:00:00.000Z" },
    "/a/zzz": { lastSessionModified: "2026-08-04T00:00:00.000Z" },
    "/undated": {},
  };
  // Deliberately absent: a `lastSessionModified` that `Date.parse` cannot read.
  // It makes the reference's comparator return NaN for every pair it appears
  // in, and the resulting order is then whatever V8's sort does with an
  // inconsistent comparator — a detail no port should be pinned to.
  // Enough to run past the twenty-five the endpoint returns, dated so the
  // oldest fall off the end rather than the newest.
  for (let index = 0; index < 25; index += 1) {
    projects[`/bulk-${String(index).padStart(2, "0")}`] = {
      lastSessionModified: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    };
  }
  return `${JSON.stringify(
    {
      mcpServers: {
        zeta: { command: "node", args: ["one", 2, "three"], type: "stdio" },
        alpha: { type: "http", url: "https://alpha.example" },
        "not-an-object": 7,
        "wrong-types": { command: 5, args: "nope", type: true, url: null },
      },
      projects,
    },
    null,
    2,
  )}\n`;
}

/** Hooks, in the nesting `settings.json` uses: event → entries → hooks. */
const CLAUDE_SETTINGS = `${JSON.stringify(
  {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "echo before" },
            { type: "command", command: "echo also-before" },
          ],
        },
        // No matcher at all, which sorts ahead of "Bash" as the empty string.
        { hooks: [{ type: "command", command: "echo unmatched" }] },
        // Not an object, and an entry whose `hooks` is not an array.
        7,
        { matcher: "Read", hooks: "nope" },
      ],
      // Sorts before PreToolUse.
      Notification: [{ hooks: [{ type: "command", command: "echo note" }, null, 5] }],
      // Not an array: skipped entirely.
      SessionStart: { hooks: [] },
    },
    // Not a hook, and must survive being ignored.
    model: "claude-opus-5",
  },
  null,
  2,
)}\n`;

const CLAUDE_SETTINGS_LOCAL = `${JSON.stringify(
  {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo local" }] }],
    },
  },
  null,
  2,
)}\n`;

const PROJECT_SETTINGS = `${JSON.stringify(
  {
    hooks: {
      PostToolUse: [{ matcher: "Edit", hooks: [{ command: "echo project-scope" }] }],
    },
  },
  null,
  2,
)}\n`;

/** The plugin registry, plus the shapes a hand-edited one takes. */
function installedPlugins(home: string): string {
  return `${JSON.stringify(
    {
      plugins: {
        "beta@market": [{ scope: "user", installPath: `${home}/plugins/beta`, version: "1.2.3" }],
        "alpha@market": [{ scope: "project", installPath: `${home}/plugins/alpha`, version: "0.1" }],
        // No marketplace suffix at all, so the whole key is the name.
        bare: [{ scope: "user", installPath: `${home}/plugins/bare` }],
        // A leading `@` is not a separator: `lastIndexOf` must be > 0.
        "@scoped": [{ installPath: `${home}/plugins/missing` }],
        // Two separators, so splitting at the first and at the last differ:
        // the name is everything before the *last* one.
        "scoped@name@market": [{ scope: "user", installPath: `${home}/plugins/bare` }],
        // No records, and a record with no install path.
        empty: [],
        "no-path@market": [{ scope: "user", version: "9" }],
      },
    },
    null,
    2,
  )}\n`;
}

const PLUGIN_MCP = `${JSON.stringify({
  mcpServers: { "zed-server": {}, "acme-server": {} },
})}\n`;

/** No `mcpServers` wrapper: the whole document is the server map. */
const PLUGIN_MCP_BARE = `${JSON.stringify({ "bare-server": {}, another: {} })}\n`;

const PLUGIN_MANIFEST = `${JSON.stringify({ name: "beta", description: "The beta plugin." })}\n`;

/**
 * Codex's config, in the subset of TOML the reference parses by hand: bare and
 * quoted keys, dotted section names, arrays, booleans, and comments both inside
 * and outside strings.
 */
/**
 * A hook's trust state is keyed by the hook's *id*, which is its settings file's
 * absolute path plus its position — so the config has to be written per runtime
 * or the two state lookups below never fire and the hook cases assert nothing.
 *
 * Both lookups are exercised: `Notification` is keyed by the id exactly as the
 * settings file produces it, and `PreToolUse` only by the snake-case form the
 * reference falls back to. The section names are quoted, so the dots inside the
 * paths must not split them.
 */
function codexConfig(userHooks: string, projectHooks: string): string {
  return `# a leading comment
model = "gpt-5"

[mcp_servers.zulu]
command = "node"
args = ["a", "b"]  # trailing comment

[mcp_servers.alpha]
# The hash below is inside the quotes, so it is part of the URL, not a comment.
url = "https://alpha.example/docs#usage"
type = "http"
# A boolean in an array is dropped; everything else survives as text.
args = ["keep", true, "also-keep"]

[mcp_servers."quoted.name"]
command = "quoted"

[projects."/from/config"]
trust_level = "trusted"

[projects."/alpha"]
trust_level = "trusted"

[hooks.state."${userHooks}:Notification:0:0"]
enabled = true
trusted_hash = "abc"

[hooks.state."${userHooks}:pre_tool_use:0:0"]
enabled = false

[hooks.state."${projectHooks}:SessionEnd:0:0"]
enabled = "not a boolean"

[not.a.section.we.read]
ignored = true

[mcp_servers]
too_short = "ignored"
`;
}

const CODEX_HOOKS = `${JSON.stringify(
  {
    hooks: {
      PreToolUse: [{ matcher: "Shell", hooks: [{ type: "command", command: "echo codex" }] }],
      Notification: [{ hooks: [{ type: "command", command: "echo codex-note" }] }],
    },
  },
  null,
  2,
)}\n`;

const CODEX_PROJECT_HOOKS = `${JSON.stringify(
  {
    hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "echo codex-project" }] }] },
  },
  null,
  2,
)}\n`;

function sessionMeta(cwd: string, timestamp: string, extra = ""): string {
  return `${JSON.stringify({
    type: "session_meta",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: { cwd, timestamp },
  })}\n${extra}`;
}

// --- steps --------------------------------------------------------------------

/**
 * The endpoint answers one enormous document, so the cases are *slices* of it
 * rather than one all-or-nothing comparison. A `fetch` step takes the payload
 * once; the `view` steps after it each assert one named part, so a divergence
 * names the collector that produced it instead of printing the whole agent.
 */
interface FetchStep {
  readonly kind: "fetch";
  readonly name: string;
  readonly path?: string;
  readonly method?: string;
}

interface ViewStep {
  readonly kind: "view";
  readonly name: string;
  readonly select: (agent: Record<string, unknown>) => unknown;
}

interface WriteStep {
  readonly kind: "write";
  readonly name: string;
  readonly files: Record<string, string | null | ((runtime: Runtime) => string)>;
}

type Step = FetchStep | ViewStep | WriteStep;

const profile = (agent: Record<string, unknown>, who: string): Record<string, unknown> =>
  ((agent.agents as Record<string, Record<string, unknown>>) ?? {})[who] ?? {};

/** The same eleven slices, for whichever profile. */
function profileViews(who: string): ViewStep[] {
  return (["project", "skills", "mcpServers", "plugins", "hooks", "projects"] as const).map(
    (part) => ({
      kind: "view" as const,
      name: `${who}/${part}`,
      select: (agent) => profile(agent, who)[part],
    }),
  );
}

/** The shape of the envelope, which no single slice above would notice losing. */
const SHAPE_VIEWS: ViewStep[] = [
  { kind: "view", name: "shape/top-level-keys", select: (agent) => Object.keys(agent) },
  {
    kind: "view",
    name: "shape/agent-names",
    select: (agent) => Object.keys((agent.agents as object) ?? {}),
  },
  {
    kind: "view",
    name: "shape/active-profile-is-spread-at-the-top",
    select: (agent) => ({
      skills: agent.skills,
      mcpServers: agent.mcpServers,
      hooks: agent.hooks,
      projects: agent.projects,
      project: agent.project,
      plugins: agent.plugins,
    }),
  },
];

/**
 * Key *order*, as content.
 *
 * `deepStrictEqual` compares objects without regard to the order their keys
 * were inserted in, so every ordering decision the reference makes while
 * building a row is invisible to an ordinary view. `Object.keys` turns it into
 * an array, which is compared in order. The one that matters most is a merged
 * Codex project: a directory the config already knew about gains
 * `lastSessionModified` at the end, and one only a session mentions carries it
 * in the middle.
 */
function keyOrderViews(): ViewStep[] {
  const parts = ["projects", "hooks", "plugins"] as const;
  return ["claude-code", "codex"].flatMap((who) =>
    parts.map((part) => ({
      kind: "view" as const,
      name: `${who}/${part}-key-order`,
      select: (agent: Record<string, unknown>) =>
        ((profile(agent, who)[part] as Record<string, unknown>[]) ?? []).map((row) =>
          Object.keys(row ?? {}),
        ),
    })),
  );
}

const DETECTED: ViewStep = {
  kind: "view",
  name: "detected",
  select: (agent) => agent.detected,
};

function everyView(): Step[] {
  return [DETECTED, ...profileViews("claude-code"), ...profileViews("codex"), ...SHAPE_VIEWS];
}

interface Phase {
  readonly name: string;
  /** Applied over the inherited environment; "" clears an inherited signal. */
  readonly env: Record<string, string>;
  /** Where this phase's Codex fixtures are planted, relative to the home. */
  readonly codexHome: string;
  readonly steps: Step[];
}

/** Every signal the reference reads, cleared, so a phase only sees what it sets. */
const NO_SIGNALS: Record<string, string> = {
  CLAUDECODE: "",
  CLAUDE_CODE_ENTRYPOINT: "",
  CLAUDE_PROJECT_DIR: "",
  CODEX_HOME: "",
  CODEX_SANDBOX: "",
  CODEX_CLI: "",
  GEMINI_API_KEY: "",
  GEMINI_CLI: "",
  GOOGLE_GENAI_USE_VERTEXAI: "",
};

const phases: Phase[] = [
  {
    name: "unknown",
    env: NO_SIGNALS,
    codexHome: ".codex",
    steps: [
      { kind: "fetch", name: "fetch/seeded" },
      ...everyView(),
      ...keyOrderViews(),

      // --- instructions and memory ------------------------------------------
      {
        kind: "write",
        name: "remove CLAUDE.md, leaving only AGENTS.md",
        files: { "workspace/CLAUDE.md": null },
      },
      { kind: "fetch", name: "fetch/no-claude-md" },
      {
        kind: "view",
        name: "no-claude-md/claude-project",
        select: (agent) => profile(agent, "claude-code").project,
      },
      {
        kind: "write",
        name: "an instruction file too long to show whole",
        files: { "workspace/CLAUDE.md": `${"x".repeat(1300)}\nlast line\n` },
      },
      { kind: "fetch", name: "fetch/truncated-instructions" },
      {
        kind: "view",
        name: "truncated/claude-project",
        select: (agent) => profile(agent, "claude-code").project,
      },
      {
        kind: "write",
        name: "an instruction file exactly at the preview limit",
        files: { "workspace/CLAUDE.md": "y".repeat(1200) },
      },
      { kind: "fetch", name: "fetch/instructions-at-the-limit" },
      {
        kind: "view",
        name: "at-the-limit/claude-project",
        select: (agent) => profile(agent, "claude-code").project,
      },

      // --- the plugin registry ----------------------------------------------
      {
        kind: "write",
        name: "a plugin registry that does not parse",
        files: { ".claude/plugins/installed_plugins.json": "{ not json" },
      },
      { kind: "fetch", name: "fetch/broken-plugin-registry" },
      {
        kind: "view",
        name: "broken-registry/claude-plugins",
        select: (agent) => profile(agent, "claude-code").plugins,
      },
      {
        kind: "write",
        name: "a plugin registry with no plugins key",
        files: { ".claude/plugins/installed_plugins.json": '{"other":1}\n' },
      },
      { kind: "fetch", name: "fetch/empty-plugin-registry" },
      {
        kind: "view",
        name: "empty-registry/claude-plugins",
        select: (agent) => profile(agent, "claude-code").plugins,
      },

      // --- the hand-rolled TOML parser --------------------------------------
      {
        kind: "write",
        name: "a codex config with no sections this reads",
        files: { ".codex/config.toml": "model = \"x\"\n[unrelated]\nkey = 1\n" },
      },
      { kind: "fetch", name: "fetch/bare-codex-config" },
      {
        kind: "view",
        name: "bare-config/codex-mcp-servers",
        select: (agent) => profile(agent, "codex").mcpServers,
      },
      {
        kind: "view",
        name: "bare-config/codex-projects",
        select: (agent) => profile(agent, "codex").projects,
      },
      {
        kind: "view",
        name: "bare-config/codex-hooks",
        select: (agent) => profile(agent, "codex").hooks,
      },
      {
        kind: "write",
        name: "no codex config at all",
        files: { ".codex/config.toml": null },
      },
      { kind: "fetch", name: "fetch/no-codex-config" },
      {
        kind: "view",
        name: "no-config/codex-hooks",
        select: (agent) => profile(agent, "codex").hooks,
      },
      {
        kind: "view",
        name: "no-config/codex-projects",
        select: (agent) => profile(agent, "codex").projects,
      },

      // --- paths that match nothing -----------------------------------------
      { kind: "fetch", name: "shape/agent-rejects-post", method: "POST", path: "/api/agent" },
      { kind: "fetch", name: "shape/a-trailing-slash", path: "/api/agent/" },
    ],
  },
  {
    name: "claude-code",
    env: {
      ...NO_SIGNALS,
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_PROJECT_DIR: "/somewhere",
    },
    codexHome: ".codex",
    steps: [{ kind: "fetch", name: "fetch/claude-code" }, DETECTED, ...SHAPE_VIEWS],
  },
  {
    name: "codex",
    // Setting CODEX_HOME both relocates the Codex fixtures and is itself the
    // signal that makes this a Codex session, which is why the relocated tree
    // is what the answer has to be built from.
    env: { ...NO_SIGNALS, CODEX_HOME: "<home>/relocated-codex", CODEX_SANDBOX: "seatbelt" },
    codexHome: "relocated-codex",
    steps: [
      { kind: "fetch", name: "fetch/codex" },
      DETECTED,
      ...SHAPE_VIEWS,
      {
        kind: "view",
        name: "relocated/codex-mcp-servers",
        select: (agent) => profile(agent, "codex").mcpServers,
      },
      {
        kind: "view",
        name: "relocated/codex-skills",
        select: (agent) => profile(agent, "codex").skills,
      },
      {
        kind: "view",
        name: "relocated/codex-project",
        select: (agent) => profile(agent, "codex").project,
      },
    ],
  },
  {
    name: "gemini",
    env: { ...NO_SIGNALS, GEMINI_API_KEY: "k", GEMINI_CLI: "1", GOOGLE_GENAI_USE_VERTEXAI: "1" },
    codexHome: ".codex",
    steps: [{ kind: "fetch", name: "fetch/gemini" }, DETECTED, ...SHAPE_VIEWS],
  },
];

// --- driver -------------------------------------------------------------------

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

const credentials = new Map<Runtime, string>();
const realWorkspace = new Map<Runtime, string>();

function workspaceKey(runtime: Runtime): string {
  return realWorkspace.get(runtime) ?? runtime.workspace;
}

/** Claude Code's encoding of a project directory into a single path segment. */
function projectSlug(cwd: string): string {
  return cwd.replace(/[/\\]/g, "-").replace(/\s+/g, "-");
}

async function send(runtime: Runtime, step: FetchStep): Promise<Answer> {
  const credential = credentials.get(runtime) ?? "";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path ?? "/api/agent"}`, {
    method: step.method ?? "GET",
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
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

async function write(runtime: Runtime, relative: string, contents: string): Promise<void> {
  const target = join(runtime.home, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function seed(runtime: Runtime, codexHome: string): Promise<void> {
  const home = workspaceKey(runtime).replace(/\/workspace$/, "");
  const slug = projectSlug(workspaceKey(runtime));

  // --- Claude, under the home ---------------------------------------------
  await write(runtime, ".claude.json", claudeJson(workspaceKey(runtime)));
  await write(runtime, ".claude/settings.json", CLAUDE_SETTINGS);
  await write(runtime, ".claude/settings.local.json", CLAUDE_SETTINGS_LOCAL);
  await write(runtime, ".claude/skills/formatting/SKILL.md", skill("Formats things."));
  await write(runtime, ".claude/skills/zeta-skill/SKILL.md", skill('"A quoted description."'));
  await write(runtime, ".claude/skills/no-description/SKILL.md", skill(null));
  // The `description:` line sits past the four hundred units that are read.
  await write(
    runtime,
    ".claude/skills/late-description/SKILL.md",
    `---\nname: ignored\npadding: ${"p".repeat(420)}\ndescription: Too late to be seen.\n---\n`,
  );
  // `description:` with nothing after it: the reference's `\s*` crosses the
  // newline, so the value is the next line rather than empty.
  await write(
    runtime,
    ".claude/skills/wrapped-description/SKILL.md",
    "---\nname: ignored\ndescription:\n  Wrapped onto the next line.\n---\n\nBody.\n",
  );
  // A command file whose name ends in `.md` twice keeps its inner suffix.
  await write(runtime, "plugins/beta/commands/notes.md.md", "n\n");
  // A skill directory with no SKILL.md, and a plain file among the directories.
  await write(runtime, ".claude/skills/no-skill-file/README.md", "nothing here\n");
  await write(runtime, ".claude/skills/loose-file.md", "not a skill\n");
  await write(runtime, ".claude/plugins/data/plugin-one/skills/first/SKILL.md", skill("First."));
  await write(runtime, ".claude/plugins/data/plugin-one/skills/second/SKILL.md", skill(null));
  // No `skills/` directory at all: contributes nothing rather than failing.
  await write(runtime, ".claude/plugins/data/plugin-two/commands/x.md", "x\n");
  await write(runtime, ".claude/plugins/installed_plugins.json", installedPlugins(home));

  await write(runtime, "plugins/beta/skills/one/SKILL.md", skill("One."));
  await write(runtime, "plugins/beta/skills/two/SKILL.md", skill(null));
  await write(runtime, "plugins/beta/skills/.hidden/SKILL.md", skill(null));
  await write(runtime, "plugins/beta/commands/deploy.md", "d\n");
  await write(runtime, "plugins/beta/commands/audit.md", "a\n");
  await write(runtime, "plugins/beta/commands/notes.txt", "ignored\n");
  await write(runtime, "plugins/beta/agents/reviewer.md", "r\n");
  await write(runtime, "plugins/beta/.mcp.json", PLUGIN_MCP);
  await write(runtime, "plugins/beta/.claude-plugin/plugin.json", PLUGIN_MANIFEST);
  await write(runtime, "plugins/alpha/.mcp.json", PLUGIN_MCP_BARE);
  await write(runtime, "plugins/bare/readme.md", "nothing\n");

  await write(runtime, `.claude/projects/${slug}/memory/MEMORY.md`, "# index\n");
  await write(runtime, `.claude/projects/${slug}/memory/zeta.md`, "z\n");
  // Sorts before `zeta.md` by collation and after it by code unit, so the two
  // orderings are told apart.
  await write(runtime, `.claude/projects/${slug}/memory/\u00c9clair.md`, "e\n");
  await write(runtime, `.claude/projects/${slug}/memory/alpha.md`, "a\n");
  await write(runtime, `.claude/projects/${slug}/memory/notes.txt`, "not markdown\n");

  // --- Codex, under this phase's CODEX_HOME --------------------------------
  await write(runtime, `${codexHome}/memories/beta.md`, "b\n");
  await write(runtime, `${codexHome}/memories/alpha.md`, "a\n");
  await write(runtime, `${codexHome}/memories/skipme.txt`, "not markdown\n");
  await write(runtime, `${codexHome}/skills/legacy-one/SKILL.md`, skill("Legacy."));
  // A dot directory here is skipped, but `.system` is read as its own scope.
  await write(runtime, `${codexHome}/skills/.hidden/SKILL.md`, skill("Hidden."));
  await write(runtime, `${codexHome}/skills/.system/builtin/SKILL.md`, skill("Built in."));
  await write(runtime, `${codexHome}/hooks.json`, CODEX_HOOKS);
  await write(
    runtime,
    `${codexHome}/config.toml`,
    codexConfig(
      join(runtime.home, codexHome, "hooks.json"),
      join(workspaceKey(runtime), ".codex", "hooks.json"),
    ),
  );
  await write(
    runtime,
    `${codexHome}/sessions/2026/08/current.jsonl`,
    sessionMeta(workspaceKey(runtime), "2026-08-05T00:00:00.000Z"),
  );
  await write(
    runtime,
    `${codexHome}/sessions/2026/08/alpha.jsonl`,
    sessionMeta("/alpha", "2026-08-02T00:00:00.000Z"),
  );
  // An older reading for the same directory: the newer one above must win.
  await write(
    runtime,
    `${codexHome}/sessions/2026/07/alpha-older.jsonl`,
    sessionMeta("/alpha", "2026-07-02T00:00:00.000Z"),
  );
  await write(runtime, `${codexHome}/sessions/not-a-meta.jsonl`, '{"type":"other"}\n');
  await write(runtime, `${codexHome}/sessions/unparseable.jsonl`, "{ not json\n");
  await write(runtime, `${codexHome}/sessions/notes.txt`, "ignored\n");

  await write(runtime, ".agents/skills/standard-one/SKILL.md", skill("Standard."));

  // --- the project tree ----------------------------------------------------
  await write(runtime, "workspace/CLAUDE.md", "# Claude instructions\n");
  await write(runtime, "workspace/AGENTS.md", "# Codex instructions\n");
  await write(runtime, "workspace/.claude/skills/project-skill/SKILL.md", skill("Project."));
  await write(runtime, "workspace/.claude/settings.json", PROJECT_SETTINGS);
  await write(runtime, "workspace/.codex/memories/project-note.md", "p\n");
  await write(runtime, "workspace/.codex/skills/project-codex/SKILL.md", skill("Project codex."));
  await write(runtime, "workspace/.agents/skills/project-standard/SKILL.md", skill(null));
  await write(runtime, "workspace/.codex/hooks.json", CODEX_PROJECT_HOOKS);

  // Fixed, so the two runtimes' rollouts are ordered identically rather than
  // merely written in the same order.
  for (const [relative, offset] of [
    [`${codexHome}/sessions/2026/08/current.jsonl`, 300],
    [`${codexHome}/sessions/2026/08/alpha.jsonl`, 200],
    [`${codexHome}/sessions/2026/07/alpha-older.jsonl`, 100],
  ] as const) {
    await utimes(join(runtime.home, relative), EPOCH + offset, EPOCH + offset);
  }
}

/**
 * Erase each runtime's own home, in both the spellings it appears in.
 *
 * The slugged form matters as much as the path: Claude Code encodes a project
 * directory into a single path segment, so the memory directory contains the
 * home with its separators replaced. Erasing only the path leaves the slug
 * behind and every memory case fails for the one reason that is not a
 * divergence.
 */
function erase(value: string, runtime: Runtime): string {
  const withPrivate = `/private${runtime.home}`;
  return value
    .split(withPrivate)
    .join("<home>")
    .split(runtime.home)
    .join("<home>")
    .split(projectSlug(withPrivate))
    .join("<home-slug>")
    .split(projectSlug(runtime.home))
    .join("<home-slug>");
}

function normalize(value: unknown, runtime: Runtime): unknown {
  return JSON.parse(erase(JSON.stringify(value ?? null), runtime));
}

const root = await mkdtemp(join(tmpdir(), "nmi-agent-info-parity-"));
let failures = 0;
let compared = 0;

for (const phase of phases) {
  // A recording per phase, not per gate. Every phase asks the same daemon the
  // same paths under a different environment, so one recording for all four
  // would let a phase be answered with another phase's replies — the replay
  // server matches on method and path, and cannot tell them apart. Separate
  // files keep each phase's answers, and its own ordering, to itself.
  const harness = new RuntimeHarness(join(root, phase.name), `${gateName()}-${phase.name}`);
  try {
    const runtimes: Runtime[] = [];
    for (const spec of [referenceSpec(), candidateSpec(argv)]) {
      const runtime = await harness.provision(
        spec,
        () => ({ version: 1, services: [], bundles: [], databases: [], gitRepositories: [] }),
        () => [],
      );
      realWorkspace.set(runtime, await realpath(runtime.workspace));
      await seed(runtime, phase.codexHome);
      const env = Object.fromEntries(
        Object.entries(phase.env).map(([key, value]) => [
          key,
          value.replace("<home>", runtime.home),
        ]),
      );
      await harness.startDaemon(runtime, env, runtime.workspace);
      credentials.set(
        runtime,
        await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
          .then((value) => value.trim())
          .catch(() => ""),
      );
      runtimes.push(runtime);
    }
    const [reference, candidate] = runtimes;
    let answers: { reference: Answer; candidate: Answer } | undefined;

    for (const step of phase.steps) {
      const label = `${phase.name}/${step.name}`;
      if (step.kind === "write") {
        for (const runtime of runtimes) {
          for (const [relative, contents] of Object.entries(step.files)) {
            const target = join(runtime.home, relative);
            if (contents === null) {
              await rm(target, { recursive: true, force: true });
              continue;
            }
            await mkdir(dirname(target), { recursive: true });
            await writeFile(
              target,
              typeof contents === "function" ? contents(runtime) : contents,
            );
          }
        }
        console.log(`--   ${label}`);
        continue;
      }

      let pair: { reference: unknown; candidate: unknown };
      if (step.kind === "fetch") {
        answers = { reference: await send(reference, step), candidate: await send(candidate, step) };
        pair = { reference: answers.reference, candidate: answers.candidate };
      } else {
        if (!answers) throw new Error(`${label}: a view step with no fetch before it`);
        const pick = (answer: Answer) => {
          const body = answer.body as { agent?: Record<string, unknown> };
          return step.select(body?.agent ?? {});
        };
        pair = { reference: pick(answers.reference), candidate: pick(answers.candidate) };
      }

      if (dump) {
        console.log(`--- ${label} ---`);
        console.log(`  reference: ${inspect(pair.reference, { depth: null })}`);
        console.log(`  candidate: ${inspect(pair.candidate, { depth: null })}`);
      }
      compared += 1;
      try {
        assert.deepStrictEqual(
          normalize(pair.candidate, candidate),
          normalize(pair.reference, reference),
        );
        console.log(`ok   ${label}`);
      } catch (error) {
        failures += 1;
        console.log(`FAIL ${label}`);
        console.log(`  reference: ${inspect(pair.reference, { depth: null })}`);
        console.log(`  candidate: ${inspect(pair.candidate, { depth: null })}`);
        console.log(`  ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await harness.shutdown();
  }
}

await rm(root, { recursive: true, force: true, maxRetries: 5 });

if (failures > 0) {
  console.log(`\nagent-info parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nagent-info parity: ${compared} cases match`);
