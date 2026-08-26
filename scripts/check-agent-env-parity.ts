/**
 * Phase 6 parity gate for the Agent Environments surface:
 *
 *   GET  /api/agent-env/agents
 *   GET  /api/agent-env/live
 *   GET  /api/agent-env/doctor
 *   POST /api/agent-env/changes/preview
 *   POST /api/agent-env/changes/apply
 *   POST /api/agent-env/snapshot
 *   GET  /api/agent-env/settings/:agent
 *   PUT  /api/agent-env/settings/:agent
 *   POST /api/agent-env/settings/:agent/model
 *
 * The home is the fixture the MCP agent-env gate already uses
 * (`test/fixtures/mcp-agent-env-parity-v1.json`), planted directly rather than
 * through its plan: the same three agent config files, the same skills, and the
 * same two PATH stubs, so "installed" is the fixture's answer and not this
 * machine's.
 *
 * **Two guards on this gate's own reach:**
 *
 * 1. Project scope is read but never *written*. The daemon takes its `cwd` from
 *    the process, and the reference only resolves from the repository root
 *    (`--import tsx src/index.ts`) — so a staged change with
 *    `targetScope: "project"` would write `.mcp.json` into this checkout. Those
 *    appear in `changes/preview`, which computes the same target paths without
 *    touching them, and never in `changes/apply`.
 * 2. For the same reason the project-scope halves of `live` and `doctor` answer
 *    partly from this checkout. Both runtimes are spawned in the same directory
 *    and diffed against each other, so what is installed here changes what the
 *    gate covers, never whether it passes.
 *
 * **The two `:agent` routes check things in opposite orders**, which is why the
 * 405/400 cases are doubled: `/settings/:agent` validates the agent before the
 * method (so `DELETE /settings/bogus` is a 400), and `/settings/:agent/model`
 * validates the method before the agent (so `GET /settings/bogus/model` is a
 * 405). Neither decodes its capture, so `%63laude` is not `claude`.
 *
 * Usage:
 *   node --import tsx scripts/check-agent-env-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  repoRoot,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";

const argv = process.argv.slice(2).filter((a) => a !== "--dump");
const dump = process.argv.slice(2).includes("--dump");
if (argv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-agent-env-parity.ts [--dump] <candidate> [args...]",
  );
}

const ENV = "/api/agent-env";

interface HomeFile {
  readonly path: string;
  readonly contents: string;
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  /** Raw text, so a body that is not JSON can be sent as one. */
  readonly body?: string;
  /** Written to both runtimes' homes before the request. */
  readonly writeHomeFiles?: readonly HomeFile[];
  readonly removeHomeFiles?: readonly string[];
  /** Put every fixture file back, for the step after a deliberate break. */
  readonly replant?: boolean;
}

const fixture = JSON.parse(
  await readFile(join(repoRoot(), "test/fixtures/mcp-agent-env-parity-v1.json"), "utf8"),
) as { fixtureVersion: number; pathStubs: string[]; homeFiles: HomeFile[] };
if (fixture.fixtureVersion !== 1) {
  throw new Error(`Unsupported agent-env parity fixture version ${fixture.fixtureVersion}`);
}

/**
 * One managed Claude plugin, and one the fixture cannot uninstall.
 *
 * The MCP fixture has no plugins at all, which would leave every plugin case
 * below answering "not found" from both runtimes — a pass that proves nothing.
 * `tidy` carries one of each thing a plugin can contain, because the preview's
 * warning counts them; `stale` has no install path, which is the other refusal.
 */
const PLUGIN_FILES: readonly HomeFile[] = [
  {
    path: ".claude/plugins/installed_plugins.json",
    contents: JSON.stringify(
      {
        plugins: {
          "tidy@acme": [{ installPath: "{{home}}/.claude/plugins/cache/tidy" }],
          "stale@acme": [{}],
        },
      },
      null,
      2,
    ),
  },
  {
    path: ".claude/plugins/cache/tidy/skills/tidy-up/SKILL.md",
    contents: "---\nname: tidy-up\ndescription: Tidy.\n---\n\nTidy it.\n",
  },
  {
    path: ".claude/plugins/cache/tidy/.mcp.json",
    contents: '{\n  "mcpServers": {\n    "tidy-mcp": {\n      "command": "true"\n    }\n  }\n}\n',
  },
  { path: ".claude/plugins/cache/tidy/agents/reviewer.md", contents: "# reviewer\n" },
  { path: ".claude/plugins/cache/tidy/commands/tidy.md", contents: "# tidy\n" },
];

/** The fixture's own home, plus the plugins it does not ship. */
const homeFiles: readonly HomeFile[] = [...fixture.homeFiles, ...PLUGIN_FILES];

const substitute = (value: string, runtime: Runtime): string =>
  value.split("{{home}}").join(runtime.home).split("{{repo:demo}}").join(runtime.workspace);

async function plantHomeFiles(runtime: Runtime, files: readonly HomeFile[]): Promise<void> {
  for (const file of files) {
    const target = join(runtime.home, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, substitute(file.contents, runtime));
    if (file.path.startsWith("bin/")) await chmod(target, 0o755);
  }
}

/** A staged change, with the fields the route's schema calls optional left out. */
const change = (fields: Record<string, unknown>) => fields;
const changes = (...list: Array<Record<string, unknown>>) => JSON.stringify({ changes: list });

const copyMcp = (name: string, from: string, to: string) =>
  change({ category: "mcp", action: "copy", name, sourceAgent: from, targetAgent: to });

const steps: Step[] = [
  /* ---- availability ---- */
  { name: "agents/what-is-installed", method: "GET", path: `${ENV}/agents` },
  { name: "agents/read-twice", method: "GET", path: `${ENV}/agents` },
  {
    name: "agents/after-the-claude-stub-leaves-the-path",
    method: "GET",
    path: `${ENV}/agents`,
    removeHomeFiles: ["bin/claude"],
  },
  { name: "agents/after-it-comes-back", method: "GET", path: `${ENV}/agents`, replant: true },

  /* ---- the live picture ---- */
  { name: "live/every-agent", method: "GET", path: `${ENV}/live` },
  { name: "live/read-twice", method: "GET", path: `${ENV}/live` },
  {
    name: "live/after-a-claude-config-that-is-not-json",
    method: "GET",
    path: `${ENV}/live`,
    writeHomeFiles: [{ path: ".claude.json", contents: "{ not json" }],
  },
  {
    name: "live/after-a-claude-config-that-is-a-json-array",
    method: "GET",
    path: `${ENV}/live`,
    writeHomeFiles: [{ path: ".claude.json", contents: "[]\n" }],
  },
  {
    name: "live/after-a-codex-config-that-is-not-toml",
    method: "GET",
    path: `${ENV}/live`,
    replant: true,
    writeHomeFiles: [{ path: ".codex/config.toml", contents: "[mcp_servers\n" }],
  },
  {
    name: "live/after-a-skill-with-no-frontmatter",
    method: "GET",
    path: `${ENV}/live`,
    replant: true,
    writeHomeFiles: [{ path: ".claude/skills/bare/SKILL.md", contents: "just a body\n" }],
  },
  {
    name: "live/after-a-skill-whose-name-is-not-its-directory",
    method: "GET",
    path: `${ENV}/live`,
    writeHomeFiles: [
      {
        path: ".claude/skills/renamed/SKILL.md",
        contents: "---\nname: something-else\ndescription: D.\n---\n\nB.\n",
      },
    ],
  },
  {
    name: "live/after-every-user-config-is-gone",
    method: "GET",
    path: `${ENV}/live`,
    removeHomeFiles: [
      ".claude.json",
      ".codex/config.toml",
      ".gemini/antigravity-cli/mcp_config.json",
      ".claude/skills",
      ".codex/skills",
      ".agents/skills",
    ],
  },
  { name: "live/after-the-fixture-is-back", method: "GET", path: `${ENV}/live`, replant: true },

  /* ---- doctor ---- */
  { name: "doctor/the-report", method: "GET", path: `${ENV}/doctor` },
  {
    name: "doctor/after-a-broken-claude-config",
    method: "GET",
    path: `${ENV}/doctor`,
    writeHomeFiles: [{ path: ".claude.json", contents: "{ not json" }],
  },
  {
    name: "doctor/after-a-skill-directory-with-no-skill-file",
    method: "GET",
    path: `${ENV}/doctor`,
    replant: true,
    writeHomeFiles: [{ path: ".claude/skills/empty-one/notes.txt", contents: "x\n" }],
  },
  { name: "doctor/read-twice", method: "GET", path: `${ENV}/doctor` },

  /* ---- changes/preview: the schema ---- */
  { name: "preview/no-body", method: "POST", path: `${ENV}/changes/preview` },
  { name: "preview/an-empty-object", method: "POST", path: `${ENV}/changes/preview`, body: "{}" },
  {
    name: "preview/changes-that-is-a-string",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: '{"changes":"copy"}',
  },
  {
    name: "preview/changes-that-is-null",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: '{"changes":null}',
  },
  { name: "preview/an-empty-array", method: "POST", path: `${ENV}/changes/preview`, body: changes() },
  {
    name: "preview/fifty-changes",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: JSON.stringify({
      changes: Array.from({ length: 50 }, (_, index) =>
        copyMcp(`linear`, "claude", index % 2 === 0 ? "codex" : "antigravity"),
      ),
    }),
  },
  {
    name: "preview/fifty-one-changes",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: JSON.stringify({
      changes: Array.from({ length: 51 }, () => copyMcp("linear", "claude", "codex")),
    }),
  },
  {
    name: "preview/a-change-with-no-name",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "copy", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/a-blank-name",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("", "claude", "codex")),
  },
  {
    name: "preview/a-name-that-is-only-spaces",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("   ", "claude", "codex")),
  },
  {
    name: "preview/a-name-that-is-a-number",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "copy", name: 7, sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/an-unknown-category",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "hook", action: "copy", name: "linear", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/an-unknown-action",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "rename", name: "linear", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/an-unknown-source-agent",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("linear", "cursor", "codex")),
  },
  {
    name: "preview/an-unknown-target-agent",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("linear", "claude", "cursor")),
  },
  {
    name: "preview/a-target-agent-that-is-null",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "copy", name: "linear", sourceAgent: "claude", targetAgent: null })),
  },
  {
    name: "preview/no-source-scope",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("linear", "claude", "codex")),
  },
  {
    name: "preview/a-source-scope-that-is-null",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "copy", name: "linear", sourceAgent: "claude", targetAgent: "codex", sourceScope: null })),
  },
  {
    name: "preview/an-unknown-source-scope",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "copy", name: "linear", sourceAgent: "claude", targetAgent: "codex", sourceScope: "global" })),
  },
  {
    name: "preview/an-unknown-target-scope",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "copy", name: "linear", sourceAgent: "claude", targetAgent: "codex", targetScope: "global" })),
  },
  {
    name: "preview/an-extra-key",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "copy", name: "linear", sourceAgent: "claude", targetAgent: "codex", why: "because" })),
  },
  {
    name: "preview/an-extra-top-level-key",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: JSON.stringify({ changes: [copyMcp("linear", "claude", "codex")], dryRun: true }),
  },
  {
    name: "preview/a-body-that-is-not-json",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: "changes=1",
  },
  {
    name: "preview/a-body-that-is-a-json-array",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: "[]",
  },
  {
    name: "preview/a-body-that-is-a-json-string",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: '"changes"',
  },
  { name: "preview/a-get", method: "GET", path: `${ENV}/changes/preview` },

  /* ---- changes/preview: what it says ---- */
  {
    name: "preview/copy-an-mcp-between-agents",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("linear", "claude", "codex")),
  },
  {
    name: "preview/copy-an-mcp-that-does-not-exist",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("nothing-here", "claude", "codex")),
  },
  {
    name: "preview/copy-an-mcp-to-the-agent-it-came-from",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("linear", "claude", "claude")),
  },
  {
    name: "preview/copy-with-no-target-agent",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "copy", name: "linear", sourceAgent: "claude" })),
  },
  {
    name: "preview/copy-a-remote-mcp",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("sse-one", "claude", "codex")),
  },
  {
    name: "preview/copy-an-mcp-with-neither-a-command-nor-a-url",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("no-shape", "claude", "codex")),
  },
  {
    name: "preview/copy-into-antigravity",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("linear", "claude", "antigravity")),
  },
  {
    name: "preview/copy-out-of-antigravity",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("ag-local", "antigravity", "claude")),
  },
  {
    name: "preview/copy-an-mcp-from-project-scope",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "copy", name: "scoped", sourceAgent: "claude", sourceScope: "project", targetAgent: "codex" })),
  },
  {
    name: "preview/copy-an-mcp-into-project-scope",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "copy", name: "linear", sourceAgent: "claude", targetAgent: "codex", targetScope: "project" })),
  },
  {
    name: "preview/move-an-mcp",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "move", name: "linear", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/remove-an-mcp",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "remove", name: "linear", sourceAgent: "claude" })),
  },
  {
    name: "preview/remove-an-mcp-that-does-not-exist",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "remove", name: "nothing-here", sourceAgent: "claude" })),
  },
  {
    name: "preview/remove-an-mcp-with-a-target-agent-anyway",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "mcp", action: "remove", name: "linear", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/copy-a-skill",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "skill", action: "copy", name: "summarise", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/copy-a-skill-that-does-not-exist",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "skill", action: "copy", name: "nothing-here", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/copy-a-skill-whose-directory-has-no-skill-file",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "skill", action: "copy", name: "no-skill-file", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/move-a-skill",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "skill", action: "move", name: "summarise", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/remove-a-skill",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "skill", action: "remove", name: "summarise", sourceAgent: "claude" })),
  },
  {
    name: "preview/remove-a-plugin-that-is-not-installed",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "plugin", action: "remove", name: "some-plugin", sourceAgent: "claude" })),
  },
  {
    name: "preview/remove-a-managed-plugin",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "plugin", action: "remove", name: "tidy", sourceAgent: "claude" })),
  },
  {
    name: "preview/remove-a-plugin-with-no-install-path",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "plugin", action: "remove", name: "stale", sourceAgent: "claude" })),
  },
  {
    name: "preview/remove-a-plugin-from-the-agent-that-does-not-have-it",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "plugin", action: "remove", name: "tidy", sourceAgent: "codex" })),
  },
  {
    name: "preview/remove-a-plugin-with-a-target-agent",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "plugin", action: "remove", name: "tidy", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/copy-a-plugin",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "plugin", action: "copy", name: "tidy", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/move-a-plugin",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "plugin", action: "move", name: "tidy", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/copy-a-plugins-skill-as-a-skill",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "skill", action: "copy", name: "tidy", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/a-name-with-a-slash",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("a/b", "claude", "codex")),
  },
  {
    name: "preview/a-name-with-a-dot-dot",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(change({ category: "skill", action: "copy", name: "../escape", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "preview/two-changes-at-once",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("linear", "claude", "codex"), copyMcp("sse-one", "claude", "antigravity")),
  },
  {
    name: "preview/the-same-change-twice",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("linear", "claude", "codex"), copyMcp("linear", "claude", "codex")),
  },
  {
    name: "preview/a-good-change-after-a-bad-one",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("nothing-here", "claude", "codex"), copyMcp("linear", "claude", "codex")),
  },
  {
    name: "preview/an-mcp-that-already-exists-on-the-target",
    method: "POST",
    path: `${ENV}/changes/preview`,
    body: changes(copyMcp("aa-ordered-first", "claude", "codex")),
  },

  /* ---- snapshot ---- */
  { name: "snapshot/claude", method: "POST", path: `${ENV}/snapshot`, body: '{"agent":"claude"}' },
  { name: "snapshot/claude-again", method: "POST", path: `${ENV}/snapshot`, body: '{"agent":"claude"}' },
  { name: "snapshot/codex", method: "POST", path: `${ENV}/snapshot`, body: '{"agent":"codex"}' },
  { name: "snapshot/antigravity", method: "POST", path: `${ENV}/snapshot`, body: '{"agent":"antigravity"}' },
  { name: "snapshot/an-unknown-agent", method: "POST", path: `${ENV}/snapshot`, body: '{"agent":"cursor"}' },
  { name: "snapshot/gemini", method: "POST", path: `${ENV}/snapshot`, body: '{"agent":"gemini"}' },
  { name: "snapshot/an-uppercase-agent", method: "POST", path: `${ENV}/snapshot`, body: '{"agent":"Claude"}' },
  { name: "snapshot/no-agent", method: "POST", path: `${ENV}/snapshot`, body: "{}" },
  { name: "snapshot/a-null-agent", method: "POST", path: `${ENV}/snapshot`, body: '{"agent":null}' },
  { name: "snapshot/no-body", method: "POST", path: `${ENV}/snapshot` },
  { name: "snapshot/a-body-that-is-not-json", method: "POST", path: `${ENV}/snapshot`, body: "agent=claude" },
  { name: "snapshot/an-extra-key", method: "POST", path: `${ENV}/snapshot`, body: '{"agent":"codex","force":true}' },
  { name: "snapshot/a-get", method: "GET", path: `${ENV}/snapshot` },
  {
    name: "snapshot/an-agent-whose-config-is-missing",
    method: "POST",
    path: `${ENV}/snapshot`,
    removeHomeFiles: [".gemini/antigravity-cli/mcp_config.json"],
    body: '{"agent":"antigravity"}',
  },

  /* ---- changes/apply: user scope only, and its own schema ---- */
  { name: "apply/an-empty-array", method: "POST", path: `${ENV}/changes/apply`, body: changes(), replant: true },
  { name: "apply/no-body", method: "POST", path: `${ENV}/changes/apply` },
  { name: "apply/a-body-that-is-not-json", method: "POST", path: `${ENV}/changes/apply`, body: "x" },
  {
    name: "apply/fifty-one-changes",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: JSON.stringify({
      changes: Array.from({ length: 51 }, () => copyMcp("linear", "claude", "codex")),
    }),
  },
  { name: "apply/a-get", method: "GET", path: `${ENV}/changes/apply` },
  {
    name: "apply/copy-an-mcp-that-does-not-exist",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(copyMcp("nothing-here", "claude", "codex")),
  },
  {
    name: "apply/copy-an-mcp-between-agents",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(copyMcp("local-tool", "claude", "codex")),
  },
  { name: "apply/the-live-picture-afterwards", method: "GET", path: `${ENV}/live` },
  {
    name: "apply/the-same-copy-again",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(copyMcp("local-tool", "claude", "codex")),
  },
  {
    name: "apply/copy-a-remote-mcp",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(copyMcp("sse-one", "claude", "codex")),
  },
  { name: "apply/the-live-picture-after-the-remote-copy", method: "GET", path: `${ENV}/live` },
  {
    name: "apply/a-good-change-after-a-bad-one",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(copyMcp("nothing-here", "claude", "codex"), copyMcp("zz-ordered-last", "claude", "antigravity")),
  },
  { name: "apply/the-live-picture-after-the-mixed-batch", method: "GET", path: `${ENV}/live` },
  {
    name: "apply/remove-an-mcp",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(change({ category: "mcp", action: "remove", name: "local-tool", sourceAgent: "codex" })),
  },
  { name: "apply/the-live-picture-after-the-removal", method: "GET", path: `${ENV}/live` },
  {
    name: "apply/remove-the-same-mcp-again",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(change({ category: "mcp", action: "remove", name: "local-tool", sourceAgent: "codex" })),
  },
  {
    name: "apply/move-an-mcp",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(change({ category: "mcp", action: "move", name: "docs", sourceAgent: "codex", targetAgent: "claude" })),
  },
  { name: "apply/the-live-picture-after-the-move", method: "GET", path: `${ENV}/live` },
  {
    name: "apply/copy-a-skill",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(change({ category: "skill", action: "copy", name: "summarise", sourceAgent: "claude", targetAgent: "codex" })),
  },
  { name: "apply/the-live-picture-after-the-skill-copy", method: "GET", path: `${ENV}/live` },
  {
    name: "apply/copy-the-same-skill-again",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(change({ category: "skill", action: "copy", name: "summarise", sourceAgent: "claude", targetAgent: "codex" })),
  },
  {
    name: "apply/remove-a-skill",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(change({ category: "skill", action: "remove", name: "summarise", sourceAgent: "codex" })),
  },
  { name: "apply/the-live-picture-after-the-skill-removal", method: "GET", path: `${ENV}/live` },
  {
    name: "apply/remove-a-plugin-that-is-not-installed",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(change({ category: "plugin", action: "remove", name: "some-plugin", sourceAgent: "claude" })),
  },
  {
    name: "apply/remove-a-plugin-with-no-install-path",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(change({ category: "plugin", action: "remove", name: "stale", sourceAgent: "claude" })),
  },
  {
    name: "apply/remove-a-managed-plugin",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(change({ category: "plugin", action: "remove", name: "tidy", sourceAgent: "claude" })),
  },
  { name: "apply/the-live-picture-after-the-plugin-removal", method: "GET", path: `${ENV}/live` },
  {
    name: "apply/remove-the-same-plugin-again",
    method: "POST",
    path: `${ENV}/changes/apply`,
    body: changes(change({ category: "plugin", action: "remove", name: "tidy", sourceAgent: "claude" })),
  },
  { name: "apply/the-doctor-afterwards", method: "GET", path: `${ENV}/doctor` },

  /* ---- settings: the agent capture is checked before the method ---- */
  { name: "settings/claude", method: "GET", path: `${ENV}/settings/claude`, replant: true },
  { name: "settings/codex", method: "GET", path: `${ENV}/settings/codex` },
  { name: "settings/antigravity", method: "GET", path: `${ENV}/settings/antigravity` },
  { name: "settings/an-unknown-agent", method: "GET", path: `${ENV}/settings/cursor` },
  { name: "settings/an-encoded-agent-name", method: "GET", path: `${ENV}/settings/%63laude` },
  { name: "settings/an-uppercase-agent", method: "GET", path: `${ENV}/settings/Claude` },
  { name: "settings/an-agent-with-a-trailing-space", method: "GET", path: `${ENV}/settings/claude%20` },
  { name: "settings/an-empty-agent", method: "GET", path: `${ENV}/settings/` },
  { name: "settings/a-delete-on-a-known-agent", method: "DELETE", path: `${ENV}/settings/claude` },
  { name: "settings/a-delete-on-an-unknown-agent", method: "DELETE", path: `${ENV}/settings/cursor` },
  { name: "settings/a-patch", method: "PATCH", path: `${ENV}/settings/claude` },
  { name: "settings/a-post", method: "POST", path: `${ENV}/settings/claude`, body: "{}" },
  {
    name: "settings/put-with-no-content",
    method: "PUT",
    path: `${ENV}/settings/claude`,
    body: "{}",
  },
  {
    name: "settings/put-with-a-number-content",
    method: "PUT",
    path: `${ENV}/settings/claude`,
    body: '{"content":7}',
  },
  {
    name: "settings/put-with-a-null-content",
    method: "PUT",
    path: `${ENV}/settings/claude`,
    body: '{"content":null}',
  },
  { name: "settings/put-with-no-body", method: "PUT", path: `${ENV}/settings/claude` },
  {
    name: "settings/put-a-body-that-is-not-json",
    method: "PUT",
    path: `${ENV}/settings/claude`,
    body: "content=x",
  },
  {
    name: "settings/put-content-that-is-not-valid",
    method: "PUT",
    path: `${ENV}/settings/claude`,
    body: '{"content":"{ not json"}',
  },
  {
    name: "settings/put-an-empty-string",
    method: "PUT",
    path: `${ENV}/settings/claude`,
    body: '{"content":""}',
  },
  {
    name: "settings/put-new-content",
    method: "PUT",
    path: `${ENV}/settings/claude`,
    body: JSON.stringify({ content: '{\n  "model": "opus",\n  "cleanupPeriodDays": 7\n}\n' }),
  },
  { name: "settings/get-after-the-put", method: "GET", path: `${ENV}/settings/claude` },
  {
    name: "settings/put-the-same-content-again",
    method: "PUT",
    path: `${ENV}/settings/claude`,
    body: JSON.stringify({ content: '{\n  "model": "opus",\n  "cleanupPeriodDays": 7\n}\n' }),
  },
  {
    name: "settings/put-on-an-unknown-agent",
    method: "PUT",
    path: `${ENV}/settings/cursor`,
    body: '{"content":"{}"}',
  },
  {
    name: "settings/put-codex-content",
    method: "PUT",
    path: `${ENV}/settings/codex`,
    body: JSON.stringify({ content: 'model = "gpt-5"\napproval_policy = "on-request"\n' }),
  },
  { name: "settings/get-after-the-codex-put", method: "GET", path: `${ENV}/settings/codex` },
  {
    name: "settings/put-codex-content-that-is-not-toml",
    method: "PUT",
    path: `${ENV}/settings/codex`,
    body: '{"content":"[oops\\n"}',
  },

  {
    name: "settings/get-a-file-that-does-not-parse",
    method: "GET",
    path: `${ENV}/settings/claude`,
    writeHomeFiles: [{ path: ".claude/settings.json", contents: "{ not json" }],
  },
  {
    name: "settings/get-a-file-whose-model-is-not-a-string",
    method: "GET",
    path: `${ENV}/settings/claude`,
    writeHomeFiles: [{ path: ".claude/settings.json", contents: '{ "model": 7 }\n' }],
  },
  {
    name: "settings/get-a-file-that-is-only-whitespace",
    method: "GET",
    path: `${ENV}/settings/claude`,
    writeHomeFiles: [{ path: ".claude/settings.json", contents: "   \n" }],
  },
  {
    name: "settings/put-a-json-array",
    method: "PUT",
    path: `${ENV}/settings/claude`,
    body: '{"content":"[]"}',
  },
  {
    name: "settings/put-a-json-number",
    method: "PUT",
    path: `${ENV}/settings/claude`,
    body: '{"content":"7"}',
  },
  {
    name: "settings/set-a-model-on-a-file-that-does-not-parse",
    method: "POST",
    path: `${ENV}/settings/claude/model`,
    writeHomeFiles: [{ path: ".claude/settings.json", contents: "{ not json" }],
    body: '{"model":"opus"}',
  },
  {
    name: "settings/the-file-after-that-refusal",
    method: "GET",
    path: `${ENV}/settings/claude`,
  },
  {
    name: "settings/set-a-model-on-a-file-that-is-only-whitespace",
    method: "POST",
    path: `${ENV}/settings/claude/model`,
    writeHomeFiles: [{ path: ".claude/settings.json", contents: "\n" }],
    body: '{"model":"opus"}',
  },
  {
    name: "settings/clear-the-model",
    method: "POST",
    path: `${ENV}/settings/claude/model`,
    body: '{"model":"   "}',
  },
  { name: "settings/the-file-after-the-model-was-cleared", method: "GET", path: `${ENV}/settings/claude` },

  /* ---- settings/:agent/model: the method is checked before the agent ---- */
  { name: "model/a-get", method: "GET", path: `${ENV}/settings/claude/model` },
  { name: "model/a-get-on-an-unknown-agent", method: "GET", path: `${ENV}/settings/cursor/model` },
  { name: "model/a-put", method: "PUT", path: `${ENV}/settings/claude/model`, body: '{"model":"opus"}' },
  { name: "model/an-unknown-agent", method: "POST", path: `${ENV}/settings/cursor/model`, body: '{"model":"opus"}' },
  { name: "model/an-encoded-agent-name", method: "POST", path: `${ENV}/settings/%63laude/model`, body: '{"model":"opus"}' },
  { name: "model/no-model", method: "POST", path: `${ENV}/settings/claude/model`, body: "{}" },
  { name: "model/a-null-model", method: "POST", path: `${ENV}/settings/claude/model`, body: '{"model":null}' },
  { name: "model/a-model-that-is-a-number", method: "POST", path: `${ENV}/settings/claude/model`, body: '{"model":7}' },
  { name: "model/no-body", method: "POST", path: `${ENV}/settings/claude/model` },
  { name: "model/a-body-that-is-not-json", method: "POST", path: `${ENV}/settings/claude/model`, body: "model=opus" },
  { name: "model/an-empty-model", method: "POST", path: `${ENV}/settings/claude/model`, body: '{"model":""}' },
  { name: "model/set-a-model", method: "POST", path: `${ENV}/settings/claude/model`, body: '{"model":"sonnet"}' },
  { name: "model/get-after-the-model-set", method: "GET", path: `${ENV}/settings/claude` },
  { name: "model/set-the-same-model-again", method: "POST", path: `${ENV}/settings/claude/model`, body: '{"model":"sonnet"}' },
  { name: "model/a-model-nobody-ships", method: "POST", path: `${ENV}/settings/claude/model`, body: '{"model":"gpt-5"}' },
  { name: "model/set-a-codex-model", method: "POST", path: `${ENV}/settings/codex/model`, body: '{"model":"gpt-5-codex"}' },
  { name: "model/get-after-the-codex-model-set", method: "GET", path: `${ENV}/settings/codex` },
  { name: "model/set-an-antigravity-model", method: "POST", path: `${ENV}/settings/antigravity/model`, body: '{"model":"gemini-3-pro"}' },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers: { "content-type": "application/json" },
    body: step.body,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* the SPA shell is HTML, and is compared as the text it was */
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body: parsed };
}

/** `YYYYMMDD-HHMMSS`, with the collision suffix left visible: it is behaviour. */
const STAMP = /\b\d{8}-\d{6}\b/g;

/**
 * The one thing here that is compared by shape rather than by text.
 *
 * A refusal to write a settings file carries its parser's own diagnostic, and
 * the reference's is `smol-toml`'s: a reason drawn from that library's private
 * vocabulary, then the offending line, then a caret at the index *its* scanner
 * stopped at. Reproducing that is not a translation of one parser's errors into
 * another's — the way `js_json` reproduces V8's, which is why the JSON half of
 * this gate does compare the whole sentence — it is a second implementation of
 * smol-toml's scanner, for a sentence only a person hand-editing `config.toml`
 * ever sees.
 *
 * So the detail is a recorded divergence, and the gate holds the rest of the
 * shape to account: the 400, the `ok: false`, and the `Not valid TOML: ` prefix
 * that says which of the two formats was refused.
 */
// Applied to the *serialized* body, so it stops at the closing quote of the
// message rather than running to the end of the document.
const TOML_DETAIL = /Not valid TOML: [^"]*/;

function normalize(answer: Answer, runtime: Runtime): Answer {
  const erased = JSON.stringify(answer.body)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>")
    .split(repoRoot())
    .join("<repo>")
    .replace(STAMP, "<stamp>")
    .replace(TOML_DETAIL, "Not valid TOML: <parser detail>");
  return { ...answer, body: JSON.parse(erased) };
}

const root = await mkdtemp(join(tmpdir(), "nmi-agent-env-parity-"));
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
      () => [{ path: "README.md", contents: "# demo\n" }],
    );
    await plantHomeFiles(runtime, homeFiles);
    // The agents the fixture says are installed, and nothing else: `bin` comes
    // first so a real `claude` on this machine cannot win, and the login shell
    // is neutralised because a stub reachable only through PATH loses to
    // whatever `$SHELL -lc` would put ahead of it.
    await harness.startDaemon(runtime, {
      PATH: `${join(runtime.home, "bin")}:${process.env.PATH ?? ""}`,
      SHELL: "/bin/sh",
    });
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const step of steps) {
    for (const runtime of runtimes) {
      if (step.replant) await plantHomeFiles(runtime, homeFiles);
      for (const file of step.removeHomeFiles ?? []) {
        await rm(join(runtime.home, file), { recursive: true, force: true });
      }
      await plantHomeFiles(runtime, step.writeHomeFiles ?? []);
    }
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
  console.log(`\nagent-env parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nagent-env parity: ${steps.length} cases match`);
