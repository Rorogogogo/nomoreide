/**
 * Phase 6 parity gate for agent profiles:
 *
 *   GET    /api/agent-env/profiles
 *   POST   /api/agent-env/profiles
 *   GET    /api/agent-env/profiles/:name
 *   PATCH  /api/agent-env/profiles/:name
 *   DELETE /api/agent-env/profiles/:name
 *   POST   /api/agent-env/profiles/snapshot
 *   POST   /api/agent-env/profiles/import
 *   GET    /api/agent-env/profiles/:name/registry-diff
 *   POST   /api/agent-env/profiles/:name/{apply-preview,apply,export,refresh}
 *
 * The registry and auth block (`/registry/profiles`, `/auth/*`,
 * `install-from-registry`, `register-github`, `publish`) is deliberately *not*
 * here: every one of those talks to GitHub, and gating them means standing up a
 * stub OAuth server first. That is its own slice.
 *
 * **These routes decode their `:name`, and the settings routes do not.** Two
 * neighbouring families in the same URL space, opposite answers — so the
 * encoded-name cases below are the mirror image of the ones in
 * `check-agent-env-parity.ts`, and both are deliberate.
 *
 * **Two exact routes shadow the parameterised one.** `/profiles/snapshot` and
 * `/profiles/import` are registered before `/profiles/:name`, so a profile
 * actually named `snapshot` cannot be POSTed to — though it can still be read,
 * because the exact route only claims POST. The fixture registers one.
 *
 * **404 and 500 are split by a substring.** The `:name` route reports a failure
 * as 404 when its message *contains* "not found" anywhere, and 500 otherwise —
 * not by a typed error. A profile whose own name contains that phrase is
 * therefore able to turn an unrelated 500 into a 404, which the fixture also
 * registers.
 *
 * **The import round-trips through export.** Rather than checking in a binary
 * `.tar.gz`, the gate exports a profile and imports the file it just wrote, so
 * the archive is always one this runtime built and the two runtimes are never
 * comparing against a stale fixture.
 *
 * Usage:
 *   node --import tsx scripts/check-agent-profiles-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
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
    "Usage: node --import tsx scripts/check-agent-profiles-parity.ts [--dump] <candidate> [args...]",
  );
}

const PROFILES = "/api/agent-env/profiles";
/** Where a profile lives, relative to the runtime's home. */
const ROOT = ".config/nomoreide/agent-profiles";

interface HomeFile {
  readonly path: string;
  readonly contents: string;
  /** A stub the daemon has to be able to *run*, not merely find. */
  readonly executable?: boolean;
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: string;
  readonly contentType?: string;
  readonly writeHomeFiles?: readonly HomeFile[];
  readonly removeHomeFiles?: readonly string[];
  /** Runs against this runtime before the request. */
  readonly mutate?: (runtime: Runtime) => Promise<void>;
}

const profile = (fields: Record<string, unknown>) =>
  JSON.stringify({ mcps: {}, skills: [], plugins: [], ...fields }, null, 2);

/**
 * The profiles the gate starts with.
 *
 * `snapshot` and `not found here` exist to prove the two dispatch quirks in the
 * header; the other two carry enough of a profile to be applied and exported.
 */
const FIXTURE: readonly HomeFile[] = [
  {
    path: `${ROOT}/base/profile.json`,
    contents: profile({
      name: "base",
      description: "The one that carries things.",
      sourceAgent: "claude",
      mcps: {
        linear: { kind: "remote", transport: "http", url: "https://mcp.linear.app/mcp" },
        "local-tool": { kind: "local", command: "node", args: ["server.js"], env: { TOKEN: "shh" } },
      },
      skills: [{ name: "summarise" }],
    }),
  },
  { path: `${ROOT}/base/skills/summarise/SKILL.md`, contents: "---\nname: summarise\ndescription: S.\n---\n\nS.\n" },
  { path: `${ROOT}/empty/profile.json`, contents: profile({ name: "empty" }) },
  // Reachable by GET, unreachable by POST: the exact snapshot route wins.
  { path: `${ROOT}/snapshot/profile.json`, contents: profile({ name: "snapshot" }) },
  // Its own name is the substring the 404/500 split looks for.
  { path: `${ROOT}/is-not-found-really/profile.json`, contents: profile({ name: "is-not-found-really" }) },
  // A profile the store can list but not parse.
  { path: `${ROOT}/broken/profile.json`, contents: "{ not json" },
  // A directory in the root with no profile.json at all.
  { path: `${ROOT}/no-profile-file/notes.txt`, contents: "x\n" },
];

/** The agent configs a snapshot and an apply read. */
/**
 * The agents this fixture says are installed.
 *
 * A profile is a picture of an agent's setup, so several answers here name
 * which agents exist. Left to the host that is a different list on every
 * machine — and a recording of it only replays back where it was made.
 */
const AGENT_STUBS: readonly HomeFile[] = [
  { path: "bin/claude", contents: "#!/bin/sh\nexit 0\n", executable: true },
  { path: "bin/codex", contents: "#!/bin/sh\nexit 0\n", executable: true },
];

const AGENT_FILES: readonly HomeFile[] = [
  {
    path: ".claude.json",
    contents: JSON.stringify(
      {
        mcpServers: {
          linear: { type: "http", url: "https://mcp.linear.app/mcp" },
          "local-tool": { command: "node", args: ["server.js"], env: { TOKEN: "shh" } },
        },
      },
      null,
      2,
    ),
  },
  { path: ".claude/skills/summarise/SKILL.md", contents: "---\nname: summarise\ndescription: S.\n---\n\nS.\n" },
  { path: ".codex/config.toml", contents: 'model = "gpt-5"\n\n[mcp_servers.docs]\nurl = "https://docs.example.test/mcp"\n' },
];

const steps: Step[] = [
  /* ---- the listing ---- */
  { name: "list/every-profile", method: "GET", path: PROFILES },
  { name: "list/read-twice", method: "GET", path: PROFILES },

  /* ---- reading one ---- */
  { name: "read/one-that-carries-things", method: "GET", path: `${PROFILES}/base` },
  { name: "read/an-empty-one", method: "GET", path: `${PROFILES}/empty` },
  { name: "read/one-that-does-not-exist", method: "GET", path: `${PROFILES}/nothing-here` },
  { name: "read/one-that-does-not-parse", method: "GET", path: `${PROFILES}/broken` },
  { name: "read/a-directory-with-no-profile-file", method: "GET", path: `${PROFILES}/no-profile-file` },
  // The exact POST route does not claim GET, so this reaches the pattern.
  { name: "read/the-one-named-snapshot", method: "GET", path: `${PROFILES}/snapshot` },
  { name: "read/the-one-whose-name-says-not-found", method: "GET", path: `${PROFILES}/is-not-found-really` },
  // Decoded here, unlike the settings routes.
  { name: "read/an-encoded-name", method: "GET", path: `${PROFILES}/%62ase` },
  { name: "read/a-name-with-an-encoded-space", method: "GET", path: `${PROFILES}/base%20` },
  { name: "read/a-name-with-a-malformed-escape", method: "GET", path: `${PROFILES}/ba%zze` },
  { name: "read/a-name-that-is-dot-dot", method: "GET", path: `${PROFILES}/..` },
  { name: "read/a-name-that-is-encoded-dot-dot", method: "GET", path: `${PROFILES}/%2e%2e` },
  { name: "read/an-empty-name", method: "GET", path: `${PROFILES}/` },

  /* ---- creating ---- */
  { name: "create/a-profile", method: "POST", path: PROFILES, body: '{"name":"made"}' },
  { name: "create/the-listing-afterwards", method: "GET", path: PROFILES },
  { name: "create/the-same-name-again", method: "POST", path: PROFILES, body: '{"name":"made"}' },
  { name: "create/with-a-description", method: "POST", path: PROFILES, body: '{"name":"described","description":"why"}' },
  { name: "create/no-name", method: "POST", path: PROFILES, body: "{}" },
  { name: "create/a-blank-name", method: "POST", path: PROFILES, body: '{"name":""}' },
  { name: "create/a-name-that-is-a-number", method: "POST", path: PROFILES, body: '{"name":7}' },
  { name: "create/a-name-that-is-null", method: "POST", path: PROFILES, body: '{"name":null}' },
  { name: "create/a-name-with-a-slash", method: "POST", path: PROFILES, body: '{"name":"a/b"}' },
  { name: "create/a-name-that-is-dot-dot", method: "POST", path: PROFILES, body: '{"name":".."}' },
  { name: "create/a-name-that-starts-with-a-dot", method: "POST", path: PROFILES, body: '{"name":".hidden"}' },
  { name: "create/a-name-with-a-space", method: "POST", path: PROFILES, body: '{"name":"two words"}' },
  { name: "create/a-name-with-punctuation", method: "POST", path: PROFILES, body: '{"name":"a.b_c-d"}' },
  // One validator trims before it checks and the other does not, so a padded
  // name is the shape that says whether they agree.
  { name: "create/a-name-with-padding", method: "POST", path: PROFILES, body: '{"name":"  padded  "}' },
  { name: "create/the-listing-after-the-padded-name", method: "GET", path: PROFILES },
  { name: "create/a-name-that-is-only-spaces", method: "POST", path: PROFILES, body: '{"name":"   "}' },
  { name: "create/a-name-with-a-newline", method: "POST", path: PROFILES, body: '{"name":"line\\nbreak"}' },
  { name: "create/a-description-that-is-a-number", method: "POST", path: PROFILES, body: '{"name":"numdesc","description":7}' },
  { name: "create/an-extra-key", method: "POST", path: PROFILES, body: '{"name":"extra","mcps":{"x":{"command":"true"}}}' },
  { name: "create/no-body", method: "POST", path: PROFILES },
  { name: "create/a-body-that-is-not-json", method: "POST", path: PROFILES, body: "name=x" },
  { name: "create/a-body-that-is-an-array", method: "POST", path: PROFILES, body: "[]" },
  { name: "create/the-listing-after-the-refusals", method: "GET", path: PROFILES },

  /* ---- patching ---- */
  { name: "patch/a-description", method: "PATCH", path: `${PROFILES}/made`, body: '{"description":"now set"}' },
  { name: "patch/the-profile-afterwards", method: "GET", path: `${PROFILES}/made` },
  { name: "patch/nothing-at-all", method: "PATCH", path: `${PROFILES}/made`, body: "{}" },
  { name: "patch/mcps", method: "PATCH", path: `${PROFILES}/made`, body: '{"mcps":{"added":{"command":"true"}}}' },
  { name: "patch/the-profile-after-the-mcps", method: "GET", path: `${PROFILES}/made` },
  { name: "patch/skills", method: "PATCH", path: `${PROFILES}/made`, body: '{"skills":[{"name":"summarise"}]}' },
  { name: "patch/a-name-change-is-not-a-field", method: "PATCH", path: `${PROFILES}/made`, body: '{"name":"renamed"}' },
  { name: "patch/the-profile-after-the-name-attempt", method: "GET", path: `${PROFILES}/made` },
  { name: "patch/mcps-that-are-an-array", method: "PATCH", path: `${PROFILES}/made`, body: '{"mcps":[]}' },
  { name: "patch/skills-that-are-an-object", method: "PATCH", path: `${PROFILES}/made`, body: '{"skills":{}}' },
  { name: "patch/a-description-that-is-null", method: "PATCH", path: `${PROFILES}/made`, body: '{"description":null}' },
  { name: "patch/one-that-does-not-exist", method: "PATCH", path: `${PROFILES}/nothing-here`, body: '{"description":"x"}' },
  { name: "patch/one-that-does-not-parse", method: "PATCH", path: `${PROFILES}/broken`, body: '{"description":"x"}' },
  { name: "patch/no-body", method: "PATCH", path: `${PROFILES}/made` },
  { name: "patch/a-body-that-is-not-json", method: "PATCH", path: `${PROFILES}/made`, body: "x=1" },

  /* ---- the method the pattern does not claim ---- */
  { name: "method/a-put-on-a-profile", method: "PUT", path: `${PROFILES}/made`, body: "{}" },
  { name: "method/a-put-on-the-collection", method: "PUT", path: PROFILES, body: "{}" },
  { name: "method/a-delete-on-the-collection", method: "DELETE", path: PROFILES },
  { name: "method/a-patch-on-the-collection", method: "PATCH", path: PROFILES, body: "{}" },

  /* ---- snapshot ---- */
  { name: "snapshot/from-claude", method: "POST", path: `${PROFILES}/snapshot`, body: '{"agent":"claude","name":"from-claude"}' },
  { name: "snapshot/the-profile-it-wrote", method: "GET", path: `${PROFILES}/from-claude` },
  { name: "snapshot/from-codex", method: "POST", path: `${PROFILES}/snapshot`, body: '{"agent":"codex","name":"from-codex"}' },
  { name: "snapshot/the-codex-profile", method: "GET", path: `${PROFILES}/from-codex` },
  { name: "snapshot/with-a-description", method: "POST", path: `${PROFILES}/snapshot`, body: '{"agent":"claude","name":"described-snap","description":"d"}' },
  { name: "snapshot/over-an-existing-name", method: "POST", path: `${PROFILES}/snapshot`, body: '{"agent":"claude","name":"base"}' },
  { name: "snapshot/an-unknown-agent", method: "POST", path: `${PROFILES}/snapshot`, body: '{"agent":"cursor","name":"x"}' },
  { name: "snapshot/no-agent", method: "POST", path: `${PROFILES}/snapshot`, body: '{"name":"x"}' },
  { name: "snapshot/no-name", method: "POST", path: `${PROFILES}/snapshot`, body: '{"agent":"claude"}' },
  { name: "snapshot/a-blank-name", method: "POST", path: `${PROFILES}/snapshot`, body: '{"agent":"claude","name":""}' },
  { name: "snapshot/a-name-that-is-dot-dot", method: "POST", path: `${PROFILES}/snapshot`, body: '{"agent":"claude","name":".."}' },
  { name: "snapshot/a-name-with-a-slash", method: "POST", path: `${PROFILES}/snapshot`, body: '{"agent":"claude","name":"a/b"}' },
  { name: "snapshot/a-name-with-padding", method: "POST", path: `${PROFILES}/snapshot`, body: '{"agent":"claude","name":"  padded-snap  "}' },
  { name: "snapshot/no-body", method: "POST", path: `${PROFILES}/snapshot` },
  { name: "snapshot/a-get", method: "GET", path: `${PROFILES}/snapshot` },
  { name: "snapshot/the-listing-afterwards", method: "GET", path: PROFILES },

  /* ---- apply-preview and apply ---- */
  { name: "apply-preview/base-onto-codex", method: "POST", path: `${PROFILES}/base/apply-preview`, body: '{"agent":"codex"}' },
  { name: "apply-preview/base-onto-claude", method: "POST", path: `${PROFILES}/base/apply-preview`, body: '{"agent":"claude"}' },
  { name: "apply-preview/an-empty-profile", method: "POST", path: `${PROFILES}/empty/apply-preview`, body: '{"agent":"codex"}' },
  { name: "apply-preview/one-that-does-not-exist", method: "POST", path: `${PROFILES}/nothing-here/apply-preview`, body: '{"agent":"codex"}' },
  { name: "apply-preview/no-agent", method: "POST", path: `${PROFILES}/base/apply-preview`, body: "{}" },
  { name: "apply-preview/an-unknown-agent", method: "POST", path: `${PROFILES}/base/apply-preview`, body: '{"agent":"cursor"}' },
  { name: "apply-preview/a-get", method: "GET", path: `${PROFILES}/base/apply-preview` },
  { name: "apply/base-onto-codex", method: "POST", path: `${PROFILES}/base/apply`, body: '{"agent":"codex"}' },
  { name: "apply/the-live-picture-afterwards", method: "GET", path: "/api/agent-env/live" },
  { name: "apply/the-same-thing-again", method: "POST", path: `${PROFILES}/base/apply`, body: '{"agent":"codex"}' },
  { name: "apply/with-a-skip-list", method: "POST", path: `${PROFILES}/base/apply`, body: '{"agent":"antigravity","skip":{"mcps":["linear"]}}' },
  { name: "apply/the-live-picture-after-the-skip", method: "GET", path: "/api/agent-env/live" },
  { name: "apply/a-skip-that-names-nothing", method: "POST", path: `${PROFILES}/base/apply`, body: '{"agent":"codex","skip":{"mcps":["absent"]}}' },
  { name: "apply/a-skip-that-is-an-array", method: "POST", path: `${PROFILES}/base/apply`, body: '{"agent":"codex","skip":[]}' },
  { name: "apply/a-skip-with-an-unknown-key", method: "POST", path: `${PROFILES}/base/apply`, body: '{"agent":"codex","skip":{"widgets":["x"]}}' },
  { name: "apply/one-that-does-not-exist", method: "POST", path: `${PROFILES}/nothing-here/apply`, body: '{"agent":"codex"}' },
  { name: "apply/one-that-does-not-parse", method: "POST", path: `${PROFILES}/broken/apply`, body: '{"agent":"codex"}' },
  { name: "apply/no-agent", method: "POST", path: `${PROFILES}/base/apply`, body: "{}" },

  /* ---- refresh ---- */
  { name: "refresh/base-from-claude", method: "POST", path: `${PROFILES}/base/refresh`, body: '{"agent":"claude"}' },
  { name: "refresh/the-profile-afterwards", method: "GET", path: `${PROFILES}/base` },
  { name: "refresh/no-agent", method: "POST", path: `${PROFILES}/base/refresh`, body: "{}" },
  { name: "refresh/an-unknown-agent", method: "POST", path: `${PROFILES}/base/refresh`, body: '{"agent":"cursor"}' },
  { name: "refresh/one-that-does-not-exist", method: "POST", path: `${PROFILES}/nothing-here/refresh`, body: '{"agent":"claude"}' },
  { name: "refresh/a-skip-is-not-read-here", method: "POST", path: `${PROFILES}/base/refresh`, body: '{"agent":"claude","skip":{"mcps":["linear"]}}' },

  /* ---- the action alternation itself ---- */
  { name: "action/an-unknown-action-is-not-a-profile", method: "POST", path: `${PROFILES}/base/demolish`, body: "{}" },
  { name: "action/an-action-on-a-name-with-a-slash", method: "POST", path: `${PROFILES}/a/b/apply`, body: '{"agent":"codex"}' },
  { name: "action/an-encoded-slash-in-the-name", method: "POST", path: `${PROFILES}/a%2Fb/apply`, body: '{"agent":"codex"}' },
  { name: "action/an-encoded-action", method: "POST", path: `${PROFILES}/base/%61pply`, body: '{"agent":"codex"}' },
  { name: "action/a-trailing-slash", method: "POST", path: `${PROFILES}/base/apply/`, body: '{"agent":"codex"}' },

  /* ---- registry-diff ---- */
  { name: "registry-diff/a-profile-with-no-link", method: "GET", path: `${PROFILES}/base/registry-diff` },
  { name: "registry-diff/one-that-does-not-exist", method: "GET", path: `${PROFILES}/nothing-here/registry-diff` },
  { name: "registry-diff/a-post", method: "POST", path: `${PROFILES}/base/registry-diff`, body: "{}" },
  {
    name: "registry-diff/a-profile-with-a-link",
    method: "GET",
    path: `${PROFILES}/empty/registry-diff`,
    writeHomeFiles: [
      {
        path: `${ROOT}/empty/registry.json`,
        contents: JSON.stringify(
          { owner: "acme", repo: "profiles", path: "empty.json", ref: "main", baseline: { name: "empty" } },
          null,
          2,
        ),
      },
    ],
  },

  /* ---- export, then import what it wrote ---- */
  { name: "export/base", method: "POST", path: `${PROFILES}/base/export`, body: "{}" },
  { name: "export/base-again", method: "POST", path: `${PROFILES}/base/export`, body: "{}" },
  { name: "export/an-empty-profile", method: "POST", path: `${PROFILES}/empty/export`, body: "{}" },
  { name: "export/one-that-does-not-exist", method: "POST", path: `${PROFILES}/nothing-here/export`, body: "{}" },
  { name: "export/an-output-path-that-is-blank", method: "POST", path: `${PROFILES}/base/export`, body: '{"outputPath":""}' },
  { name: "export/an-output-path-that-is-a-number", method: "POST", path: `${PROFILES}/base/export`, body: '{"outputPath":7}' },
  { name: "export/no-body", method: "POST", path: `${PROFILES}/base/export` },
  {
    name: "export/to-a-named-path",
    method: "POST",
    path: `${PROFILES}/base/export`,
    // Written per runtime, so each writes inside its own home.
    body: "{{OUTPUT}}",
  },
  { name: "import/no-archive-path", method: "POST", path: `${PROFILES}/import`, body: "{}" },
  { name: "import/an-archive-that-is-not-there", method: "POST", path: `${PROFILES}/import`, body: '{"archivePath":"/nonexistent/x.tar.gz"}' },
  { name: "import/an-archive-path-that-is-blank", method: "POST", path: `${PROFILES}/import`, body: '{"archivePath":""}' },
  { name: "import/what-export-wrote", method: "POST", path: `${PROFILES}/import`, body: "{{IMPORT}}" },
  { name: "import/the-same-archive-again", method: "POST", path: `${PROFILES}/import`, body: "{{IMPORT}}" },
  { name: "import/the-same-archive-with-force", method: "POST", path: `${PROFILES}/import`, body: "{{IMPORT_FORCE}}" },
  { name: "import/under-another-name", method: "POST", path: `${PROFILES}/import`, body: "{{IMPORT_AS}}" },
  { name: "import/under-a-name-that-is-dot-dot", method: "POST", path: `${PROFILES}/import`, body: "{{IMPORT_DOTDOT}}" },
  { name: "import/under-a-name-with-a-slash", method: "POST", path: `${PROFILES}/import`, body: "{{IMPORT_SLASH}}" },
  { name: "import/under-a-blank-name", method: "POST", path: `${PROFILES}/import`, body: "{{IMPORT_BLANK}}" },
  { name: "import/under-a-name-with-padding", method: "POST", path: `${PROFILES}/import`, body: "{{IMPORT_PADDED}}" },
  { name: "import/the-listing-afterwards", method: "GET", path: PROFILES },
  { name: "import/a-raw-upload-that-is-empty", method: "POST", path: `${PROFILES}/import`, body: "", contentType: "application/octet-stream" },
  { name: "import/a-raw-upload-that-is-not-an-archive", method: "POST", path: `${PROFILES}/import`, body: "not a tarball", contentType: "application/octet-stream" },

  /* ---- deleting ---- */
  { name: "delete/one-that-exists", method: "DELETE", path: `${PROFILES}/made` },
  { name: "delete/the-listing-afterwards", method: "GET", path: PROFILES },
  { name: "delete/the-same-one-again", method: "DELETE", path: `${PROFILES}/made` },
  { name: "delete/one-that-does-not-exist", method: "DELETE", path: `${PROFILES}/nothing-here` },
  { name: "delete/one-that-does-not-parse", method: "DELETE", path: `${PROFILES}/broken` },
  { name: "delete/a-name-that-is-dot-dot", method: "DELETE", path: `${PROFILES}/..` },
  { name: "delete/the-listing-at-the-end", method: "GET", path: PROFILES },
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

/** The archive `export/base` wrote, per runtime, so import has something real. */
const exported = new Map<string, string>();

/**
 * Every archive any export wrote, so the gate can take them away again.
 *
 * An export with no `outputPath` writes into the **daemon's own cwd**, and the
 * daemon's cwd is this checkout — the reference only resolves from the
 * repository root. So the default-path cases drop `.tar.gz` files into the
 * working tree, where they turn up in the next `git status` and, left alone,
 * in the next commit. Both runtimes also write the *same* filename there, so
 * the second overwrites the first; only the reported path is compared, never
 * the bytes, so that is harmless as long as it is cleaned up.
 */
const written = new Set<string>();

/**
 * Bodies that name a path have to be written per runtime: each one exports into
 * its own home, and a path from the other runtime names nothing here.
 */
function render(body: string | undefined, runtime: Runtime): string | undefined {
  if (body === undefined) return undefined;
  const archive = exported.get(runtime.label) ?? join(runtime.home, "missing.tar.gz");
  switch (body) {
    case "{{OUTPUT}}":
      return JSON.stringify({ outputPath: join(runtime.home, "exports", "named.tar.gz") });
    case "{{IMPORT}}":
      return JSON.stringify({ archivePath: archive });
    case "{{IMPORT_FORCE}}":
      return JSON.stringify({ archivePath: archive, force: true });
    case "{{IMPORT_AS}}":
      return JSON.stringify({ archivePath: archive, as: "imported-copy" });
    case "{{IMPORT_DOTDOT}}":
      return JSON.stringify({ archivePath: archive, as: "..", force: true });
    case "{{IMPORT_SLASH}}":
      return JSON.stringify({ archivePath: archive, as: "a/b", force: true });
    case "{{IMPORT_BLANK}}":
      return JSON.stringify({ archivePath: archive, as: "   ", force: true });
    case "{{IMPORT_PADDED}}":
      return JSON.stringify({ archivePath: archive, as: "  padded-import  ", force: true });
    default:
      return body;
  }
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  if (step.mutate) await step.mutate(runtime);
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers: {
      ...(await credentialFor(runtime)),
      "content-type": step.contentType ?? "application/json",
    },
    body: render(step.body, runtime),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* the SPA shell is HTML, and is compared as the text it was */
  }
  // Remember where an export landed, so the import steps can name it and the
  // run can clean up anything it left in the checkout.
  if (typeof parsed === "object" && parsed !== null) {
    const path = (parsed as { archivePath?: unknown }).archivePath;
    if (typeof path === "string") {
      if (step.name === "export/base") exported.set(runtime.label, path);
      if (path.startsWith(`${repoRoot()}/`)) written.add(path);
    }
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body: parsed };
}

/** `YYYYMMDD-HHMMSS`, and the counter a collision appends. */
const STAMP = /\b\d{8}-\d{6}(?:-\d+)?\b/g;

/**
 * `updatedAt`, but only when it is a clock reading rather than a fixture stamp.
 *
 * A profile the fixture planted carries the time `stampFixture` gave it, which
 * is identical in both homes and is what the listing's ordering is checked
 * against — so those are compared as they are. A profile *created during the
 * run* carries `Date.now()`, which the two runtimes reach a few milliseconds
 * apart. Redacting the whole field would take the fixture's ordering out of the
 * comparison along with the noise.
 */
const VOLATILE_UPDATED_AT = /"updatedAt":"(?!2026-01-01)[^"]*"/g;

function normalize(answer: Answer, runtime: Runtime): Answer {
  const erased = JSON.stringify(answer.body)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>")
    .split(repoRoot())
    .join("<repo>")
    .replace(STAMP, "<stamp>")
    .replace(VOLATILE_UPDATED_AT, '"updatedAt":"<now>"')
    // An export names a temp directory neither runtime chose.
    .replace(/\/var\/folders\/[^"]*?nomoreide-profile[^"/]*/g, "<tmp>")
    .replace(/\/tmp\/nomoreide-profile[^"/]*/g, "<tmp>");
  return { ...answer, body: JSON.parse(erased) };
}

/**
 * The one thing here that is not a diff.
 *
 * Import takes the profile's name from the archive, or from `as` when the
 * caller sends one, and joins it to the profiles root through `basename`. That
 * turns `as: ".."` into the root's *parent*. Both runtimes do it, so comparing
 * them to each other cannot see it — they agree, and the agreement is the bug.
 *
 * So this is checked absolutely instead: after an import that asks for it,
 * nothing may appear above the profiles root. A gate that only ever compares
 * two implementations cannot notice that both are wrong.
 */
async function assertNoEscape(runtime: Runtime): Promise<string | null> {
  const above = dirname(join(runtime.home, ROOT));
  const strays = (await readdir(above).catch(() => [])).filter(
    (entry) => entry === "profile.json" || entry === "skills",
  );
  return strays.length > 0 ? `${runtime.label} wrote ${strays.join(", ")} above the profiles root` : null;
}

async function plant(runtime: Runtime, files: readonly HomeFile[]): Promise<void> {
  for (const file of files) {
    const target = join(runtime.home, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents);
    if (file.executable) await chmod(target, 0o755);
  }
}

/**
 * Give every fixture profile a stamp of its own, identical in both homes.
 *
 * The listing is ordered by the profile file's mtime, newest first, falling
 * back to the name. Planting the same files into two homes a few milliseconds
 * apart orders them differently — and that is the gate's problem, not a
 * divergence: the runtimes are reading what they were given. Fixed stamps make
 * the order deterministic *and* keep it under test, where sorting the answer
 * before comparing would quietly stop testing the order at all.
 */
async function stampFixture(runtime: Runtime): Promise<void> {
  // Deliberately not alphabetical, so name order and mtime order disagree and
  // the listing has to be reporting the latter.
  const order = ["empty", "base", "no-profile-file", "snapshot", "broken", "is-not-found-really"];
  for (const [index, name] of order.entries()) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
    await utimes(join(runtime.home, ROOT, name, "profile.json"), at, at).catch(() => undefined);
  }
}

const root = await mkdtemp(join(tmpdir(), "nmi-agent-profiles-parity-"));
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
    await plant(runtime, FIXTURE);
    await plant(runtime, AGENT_FILES);
    await plant(runtime, AGENT_STUBS);
    await stampFixture(runtime);
    // Which agents are installed is the fixture's answer, not this machine's.
    // The PATH is replaced rather than prefixed so a developer's own `claude`
    // cannot be found behind the stubs, and `/usr/bin:/bin` stays because the
    // daemon shells out to `git` and `sh`.
    await harness.startDaemon(runtime, {
      PATH: `${join(runtime.home, "bin")}:/usr/bin:/bin`,
      SHELL: "/bin/sh",
    });
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const step of steps) {
    for (const runtime of runtimes) {
      for (const file of step.removeHomeFiles ?? []) {
        await rm(join(runtime.home, file), { recursive: true, force: true });
      }
      await plant(runtime, step.writeHomeFiles ?? []);
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

  // The absolute check, run against both runtimes rather than between them.
  for (const runtime of runtimes) {
    const archive = exported.get(runtime.label);
    if (!archive) continue;
    await fetch(`http://127.0.0.1:${runtime.port}${PROFILES}/import`, {
      method: "POST",
      headers: { ...(await credentialFor(runtime)), "content-type": "application/json" },
      body: JSON.stringify({ archivePath: archive, as: "..", force: true }),
    }).catch(() => undefined);
    const escaped = await assertNoEscape(runtime);
    if (escaped) {
      failures += 1;
      console.log(`FAIL invariant/import-stays-under-the-profiles-root`);
      console.log(`  ${escaped}`);
    } else {
      console.log(`ok   invariant/import-stays-under-the-profiles-root [${runtime.label}]`);
    }
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
  // Whatever the default-path exports dropped into the checkout.
  for (const path of written) await rm(path, { force: true });
}

if (failures > 0) {
  console.log(`\nagent-profiles parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nagent-profiles parity: ${steps.length} cases match`);
