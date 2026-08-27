/**
 * Phase 6 parity gate for the SSH servers surface:
 *
 *   GET    /api/servers
 *   POST   /api/servers
 *   GET    /api/servers/setup/status
 *   POST   /api/servers/setup/terminal
 *   DELETE /api/servers/:host
 *   GET    /api/servers/:host/files
 *   GET    /api/servers/:host/file
 *   POST   /api/servers/:host/probe
 *   GET    /api/servers/:host/metrics
 *   POST   /api/servers/:host/terminal
 *
 * Six of these ten reach a remote machine over `ssh`, which is exactly why they
 * have not been ported yet: nothing about them is reproducible until the remote
 * end is. So this gate plants a **stub `ssh`** first on the daemon's PATH and
 * makes it answer from the host name and the remote command it was handed.
 * That turns every remote read into a pure function of the request, and it also
 * gates something no live host could: the stub *echoes back the path it was
 * given*, so a candidate that forgets to shell-escape the path, or passes it in
 * the wrong argument position, diverges rather than quietly working.
 *
 * What the cases are actually watching for:
 *
 * **The host guard runs in three places and answers three different ways.**
 * `probe` refuses an unsafe host with a 400. `files`, `file` and `metrics`
 * refuse the same host with a **502**, because their guard throws inside the
 * block whose catch is the transport error path. `DELETE` refuses it with a
 * 400 from a *different* guard — zod's, which trims first. Four spellings of
 * one rule; a port that unifies them is wrong four times.
 *
 * **`probe` has no failure status.** An unreachable host is a 200 with
 * `reachable: false` and the *last* line of stderr. Only the host guard can
 * make it a 400.
 *
 * **Trimming is split between the route and the schema.** The route decides
 * whether `name` is present by testing `.trim()` but stores the value
 * **untrimmed**; the schema then trims it. So `"  ok  "` survives as `"ok"`
 * while `"   "` becomes absent — two different mechanisms that a single
 * `trim()` in the wrong place collapses into one.
 *
 * **A re-registered host moves to the end.** `registerSshServer` filters the
 * old entry out and appends, so re-registering the first of three reorders the
 * list. Config order is what the response returns.
 *
 * **`/api/servers/setup` is a host name.** It has one segment, so `DELETE` on
 * it matches the `:host` pattern rather than the setup routes — and `GET` on it
 * gets that pattern's 405, not the shell's 404.
 *
 * **Sorting is `localeCompare` twice over**: once inside `~/.ssh/config`
 * discovery, once again across the merged list. The fixture plants accents and
 * mixed case so byte order gives a different answer.
 *
 * **A directory listing sorts directories first and then ignores type.** A
 * symlink and a socket sort among the files by name, not after them.
 *
 * **`truncated` and `size` come from different places.** `size` is what the
 * remote header claimed; `truncated` compares it against how many bytes
 * actually arrived. The stub lies in one case so the two cannot be conflated.
 *
 * Volatile keys — a probe's `latencyMs`, a metric sample's `t`, and a terminal
 * session's pid and timestamps — are redacted. Everything else is compared
 * whole, including the content type.
 *
 * Usage:
 *   node --import tsx scripts/check-servers-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    "Usage: node --import tsx scripts/check-servers-parity.ts [--dump] <candidate> [args...]",
  );
}

/**
 * The stub `ssh`.
 *
 * Invoked as `ssh -o BatchMode=yes -o ConnectTimeout=5 <host> <command>`, so
 * the host and the remote command are always the last two arguments. It
 * dispatches on the host first — that is how a host becomes unreachable or a
 * liar — and then on which of the four remote commands it was handed.
 *
 * The directory and file scripts are invoked as
 * `LC_ALL=C sh -c '<script>' nomoreide '<path>'`, so the stub recovers the path
 * by taking what follows the last ` nomoreide ` and undoing the single-quote
 * escaping. A candidate that escapes differently, or appends the path anywhere
 * else, gets a different answer back.
 */
const SSH_STUB = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
const host = args[args.length - 2] ?? "";
const command = args[args.length - 1] ?? "";

function out(value) {
  process.stdout.write(typeof value === "string" ? Buffer.from(value, "utf8") : value);
  process.exit(0);
}
function die(message, code) {
  process.stderr.write(message);
  process.exit(code);
}

if (host === "dead") {
  die("ssh: connect to host dead port 22: Connection refused\nlost connection\n", 255);
}

/** Undo the shell escaping the caller applied to the path argument. */
function pathArgument() {
  const marker = command.lastIndexOf(" nomoreide ");
  if (marker < 0) return "<no-path-argument>";
  const raw = command.slice(marker + " nomoreide ".length).trim();
  if (!raw.startsWith("'") || !raw.endsWith("'")) return "<unquoted:" + raw + ">";
  return raw.slice(1, -1).split("'\"'\"'").join("'");
}

function nul(...parts) {
  return Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(String(part), "utf8"))));
}
const NUL = Buffer.from([0]);

// --- probe -----------------------------------------------------------------
if (command.includes("printf 'NMI\\t'")) {
  if (host === "weird") out("NOT-NMI\tsomething\nLinux\n");
  out("NMI\t" + host + "-box\nLinux\n");
}

// --- metrics ---------------------------------------------------------------
if (command.includes("read_cpu()")) {
  if (host === "nometa") out("NMI_CPU\t1.0\n");
  if (host === "shortmeta") {
    out(
      "NMI_META\t" + host + "-box\nNMI_CPU\t1.0\n" +
      "NMI_MEMORY\t8000000\t3000000\nNMI_LOAD\t0.5\t0.7\t1.2\n" +
      "NMI_UPTIME\t1\nNMI_CPUS\t4\nNMI_PROCESSES\n",
    );
  }
  if (host === "badnum") {
    out(
      "NMI_META\t" + host + "-box\tLinux\nNMI_CPU\tnot-a-number\n" +
      "NMI_MEMORY\t8000000\t3000000\nNMI_LOAD\t0.5\t0.7\t1.2\n" +
      "NMI_UPTIME\t123456.78\nNMI_CPUS\t4\nNMI_PROCESSES\n",
    );
  }
  const disk = host === "nodisk" ? "" : "NMI_DISK\t100000000\t40000000\t55000000\n";
  out(
    "NMI_META\t" + host + "-box\tLinux\n" +
    "NMI_CPU\t12.5\n" +
    "NMI_MEMORY\t8000000\t3000000\n" +
    "NMI_LOAD\t0.5\t0.7\t1.2\n" +
    "NMI_UPTIME\t123456.78\n" +
    "NMI_CPUS\t4\n" +
    disk +
    "NMI_PROCESSES\n" +
    "    1     0 root      0.5   12345 /sbin/init\n" +
    "  842     1 www-data  3.2  204800 nginx: worker process\n" +
    "this line does not match the process shape and is skipped\n" +
    "   17     1 deploy   10.75  8192 /usr/bin/node --enable-source-maps server.js\n",
  );
}

// --- directory listing -----------------------------------------------------
if (command.includes("NMI_PATH")) {
  if (host === "broken") out("NOT_A_HEADER\0/srv\0");
  const requested = pathArgument();
  const resolved = requested === "." ? "/home/deploy" : requested;
  const entries = [
    ["zeta.txt", "f", "12", "1700000000.5"],
    ["Beta", "d", "4096", "1700000001.0"],
    ["alpha", "d", "4096", "1700000002.25"],
    [".hidden.txt", "f", "3", "1700000003.0"],
    [".config", "d", "4096", "1700000004.0"],
    ["eclair", "f", "7", "1700000005.0"],
    ["éclair", "f", "9", "1700000006.0"],
    ["10-ten", "f", "1", "1700000007.0"],
    ["2-two", "f", "1", "1700000008.0"],
    ["link", "l", "11", "1700000009.0"],
    ["sock", "s", "0", "1700000010.0"],
    ["a file with spaces", "f", "5", "1700000011.0"],
  ];
  const parts = [Buffer.from("NMI_PATH", "utf8"), NUL, Buffer.from(resolved, "utf8"), NUL];
  for (const [name, type, size, mtime] of entries) {
    parts.push(
      Buffer.from("NMI_ENTRY", "utf8"), NUL,
      Buffer.from(name, "utf8"), NUL,
      Buffer.from(type, "utf8"), NUL,
      Buffer.from(size, "utf8"), NUL,
      Buffer.from(mtime, "utf8"), NUL,
      NUL,
    );
  }
  out(Buffer.concat(parts));
}

// --- file preview ----------------------------------------------------------
if (command.includes("NMI_FILE")) {
  if (host === "broken") out(nul("NOT_A_HEADER", NUL, "10", NUL, "hello"));
  const requested = pathArgument();
  if (requested === "/nope") die("Path is not a regular file.\n", 1);
  if (requested === "/var/lying") out(nul("NMI_FILE", NUL, "999999", NUL, "only ten."));
  if (requested === "/var/badsize") out(nul("NMI_FILE", NUL, "not-a-size", NUL, "hello"));
  if (requested === "/bin/blob") {
    out(nul("NMI_FILE", NUL, "8", NUL, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03])));
  }
  if (requested === "/var/huge") {
    const body = Buffer.alloc(256 * 1024 + 16, 0x61);
    out(nul("NMI_FILE", NUL, String(body.length), NUL, body));
  }
  const body = "the path was: " + requested + "\n";
  out(nul("NMI_FILE", NUL, String(Buffer.byteLength(body)), NUL, body));
}

die("stub ssh: unrecognised remote command\n", 2);
`;

/** A stand-in for `ssh-copy-id`, so the setup probe finds one on PATH. */
const COPY_ID_STUB = "#!/usr/bin/env node\nprocess.exit(0);\n";

/**
 * `~/.ssh/config`.
 *
 * `Host` is matched case-insensitively; a pattern with `*`, `?` or `!` is not a
 * concrete alias and neither is a `-`-prefixed negation; one line can name
 * several; and the same alias twice is one host. The concrete names are chosen
 * so `localeCompare` and byte order disagree about them.
 */
const SSH_CONFIG = `# a comment
Host alpha
  HostName 10.0.0.1

host beta
  User deploy

HOST gamma delta
  Port 2222

Host *.example.com
Host web-?
Host !secret
Host -oProxyCommand=danger
Host alpha
Host Zulu zeta
Host éclair eclair
Host 10-ten 2-two
Host dead weird broken nodisk badnum nometa shortmeta
`;

const PUBLIC_KEYS = ["id_rsa.pub", "id_ed25519.pub", "Backup.pub", "_work.pub"];
/** Not `.pub`, and a directory that is — neither is a public key. */
const SSH_DECOYS = ["id_rsa", "known_hosts", "config.pub.bak"];

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  readonly path: string;
  readonly body?: unknown;
  /** Sent as a raw string rather than JSON, for malformed-body cases. */
  readonly raw?: string;
}

const steps: readonly Step[] = [
  // --- the merged listing ----------------------------------------------------
  // Everything in ~/.ssh/config, nothing that was a pattern, sorted by
  // `localeCompare` rather than by byte order.
  { name: "list/discovered-only", method: "GET", path: "/api/servers" },
  { name: "list/wrong-method-put", method: "PUT", path: "/api/servers" },
  { name: "list/wrong-method-delete", method: "DELETE", path: "/api/servers" },
  { name: "list/wrong-method-patch", method: "PATCH", path: "/api/servers" },

  // --- the setup probe -------------------------------------------------------
  // `.pub` files only, sorted; `ssh-copy-id` is found by walking PATH.
  { name: "setup/status", method: "GET", path: "/api/servers/setup/status" },
  { name: "setup/status-wrong-method", method: "POST", path: "/api/servers/setup/status" },
  // One segment, so this is a *host name* to the `:host` pattern, not a prefix
  // of the setup routes.
  { name: "setup/bare-setup-is-a-host", method: "GET", path: "/api/servers/setup" },
  { name: "setup/bare-setup-deleted", method: "DELETE", path: "/api/servers/setup" },

  // --- opening a setup terminal ---------------------------------------------
  {
    name: "setup-terminal/no-action",
    method: "POST",
    path: "/api/servers/setup/terminal",
    body: {},
  },
  {
    name: "setup-terminal/unknown-action",
    method: "POST",
    path: "/api/servers/setup/terminal",
    body: { action: "rm-rf" },
  },
  {
    name: "setup-terminal/action-is-not-a-string",
    method: "POST",
    path: "/api/servers/setup/terminal",
    body: { action: 1 },
  },
  {
    name: "setup-terminal/generate-key",
    method: "POST",
    path: "/api/servers/setup/terminal",
    body: { action: "generate-key" },
  },
  // `generate-key` ignores the host entirely, even an unusable one.
  {
    name: "setup-terminal/generate-key-with-a-host",
    method: "POST",
    path: "/api/servers/setup/terminal",
    body: { action: "generate-key", host: "!! not a host !!" },
  },
  {
    name: "setup-terminal/install-key",
    method: "POST",
    path: "/api/servers/setup/terminal",
    body: { action: "install-key", host: "alpha" },
  },
  {
    name: "setup-terminal/install-key-user-at-host",
    method: "POST",
    path: "/api/servers/setup/terminal",
    body: { action: "install-key", host: "deploy@10.0.0.1" },
  },
  // The route hands the host over untrimmed and the resolver trims it, so this
  // is a valid destination whose label is the trimmed spelling.
  {
    name: "setup-terminal/install-key-padded-host",
    method: "POST",
    path: "/api/servers/setup/terminal",
    body: { action: "install-key", host: "  alpha  " },
  },
  {
    name: "setup-terminal/install-key-no-host",
    method: "POST",
    path: "/api/servers/setup/terminal",
    body: { action: "install-key" },
  },
  {
    name: "setup-terminal/install-key-blank-host",
    method: "POST",
    path: "/api/servers/setup/terminal",
    body: { action: "install-key", host: "   " },
  },
  {
    name: "setup-terminal/install-key-unsafe-host",
    method: "POST",
    path: "/api/servers/setup/terminal",
    body: { action: "install-key", host: "alpha; rm -rf /" },
  },
  // Leading `-` would be read as an option by ssh-copy-id, and the guard's
  // first character class refuses it.
  {
    name: "setup-terminal/install-key-option-host",
    method: "POST",
    path: "/api/servers/setup/terminal",
    body: { action: "install-key", host: "-oProxyCommand=danger" },
  },
  {
    name: "setup-terminal/host-is-not-a-string",
    method: "POST",
    path: "/api/servers/setup/terminal",
    body: { action: "install-key", host: 42 },
  },
  {
    name: "setup-terminal/wrong-method",
    method: "GET",
    path: "/api/servers/setup/terminal",
  },

  // --- registering -----------------------------------------------------------
  { name: "register/a-host", method: "POST", path: "/api/servers", body: { host: "srv-1" } },
  {
    name: "register/with-a-name-and-environment",
    method: "POST",
    path: "/api/servers",
    body: { host: "srv-2", name: "Web One", environment: "production" },
  },
  // The route tests `.trim()` for presence but stores the raw value; the schema
  // then trims it. Both halves have to be in the right place for this to come
  // back as `"Padded"`.
  {
    name: "register/padded-name-and-environment",
    method: "POST",
    path: "/api/servers",
    body: { host: "  srv-3  ", name: "  Padded  ", environment: "  staging  " },
  },
  // Whitespace is not a name — the route drops it before the schema sees it.
  {
    name: "register/blank-name",
    method: "POST",
    path: "/api/servers",
    body: { host: "srv-4", name: "   ", environment: "" },
  },
  {
    name: "register/name-is-not-a-string",
    method: "POST",
    path: "/api/servers",
    body: { host: "srv-5", name: 7, environment: false },
  },
  // Re-registering moves the entry to the end of the list.
  {
    name: "register/an-existing-host-again",
    method: "POST",
    path: "/api/servers",
    body: { host: "srv-1", name: "Renamed" },
  },
  { name: "register/no-host", method: "POST", path: "/api/servers", body: {} },
  {
    name: "register/host-is-not-a-string",
    method: "POST",
    path: "/api/servers",
    body: { host: 10 },
  },
  { name: "register/blank-host", method: "POST", path: "/api/servers", body: { host: "   " } },
  {
    name: "register/an-unsafe-host",
    method: "POST",
    path: "/api/servers",
    body: { host: "alpha; rm -rf /" },
  },
  {
    name: "register/a-host-starting-with-a-dash",
    method: "POST",
    path: "/api/servers",
    body: { host: "-oProxyCommand=danger" },
  },
  {
    name: "register/a-host-that-is-too-long",
    method: "POST",
    path: "/api/servers",
    body: { host: `h${"o".repeat(255)}` },
  },
  {
    name: "register/a-host-at-the-length-limit",
    method: "POST",
    path: "/api/servers",
    body: { host: `h${"o".repeat(254)}` },
  },
  {
    name: "register/a-name-at-the-length-limit",
    method: "POST",
    path: "/api/servers",
    body: { host: "srv-8", name: "n".repeat(80) },
  },
  {
    name: "register/a-name-that-is-too-long",
    method: "POST",
    path: "/api/servers",
    body: { host: "srv-6", name: "n".repeat(81) },
  },
  {
    name: "register/an-environment-that-is-too-long",
    method: "POST",
    path: "/api/servers",
    body: { host: "srv-7", environment: "e".repeat(41) },
  },
  { name: "register/a-body-that-is-not-json", method: "POST", path: "/api/servers", raw: "{" },
  { name: "register/an-empty-body", method: "POST", path: "/api/servers", raw: "" },
  { name: "register/a-body-that-is-an-array", method: "POST", path: "/api/servers", body: [] },

  // The listing now merges saved rows over discovered ones, and a saved host
  // that is not in ~/.ssh/config still lists.
  { name: "list/saved-and-discovered", method: "GET", path: "/api/servers" },
  // A saved row's name and environment win over nothing; `alpha` is in both.
  {
    name: "register/a-discovered-host",
    method: "POST",
    path: "/api/servers",
    body: { host: "alpha", name: "Alpha Box", environment: "prod" },
  },
  { name: "list/a-host-that-is-both", method: "GET", path: "/api/servers" },

  // --- removing --------------------------------------------------------------
  { name: "delete/a-saved-host", method: "DELETE", path: "/api/servers/srv-2" },
  // Filtering a list that does not contain it is not an error.
  { name: "delete/a-host-that-is-not-saved", method: "DELETE", path: "/api/servers/srv-404" },
  // Discovered hosts live in ~/.ssh/config, which this never writes.
  { name: "delete/a-discovered-host", method: "DELETE", path: "/api/servers/beta" },
  { name: "delete/a-percent-encoded-host", method: "DELETE", path: "/api/servers/deploy%4010.0.0.1" },
  // The zod guard trims first, so this removes `srv-3`.
  { name: "delete/a-padded-host", method: "DELETE", path: "/api/servers/%20srv-3%20" },
  { name: "delete/an-unsafe-host", method: "DELETE", path: "/api/servers/alpha%3B%20rm" },
  { name: "delete/a-blank-host", method: "DELETE", path: "/api/servers/%20%20" },
  { name: "delete/a-malformed-escape", method: "DELETE", path: "/api/servers/%zz" },
  { name: "delete/wrong-method-get", method: "GET", path: "/api/servers/srv-1" },
  { name: "delete/wrong-method-post", method: "POST", path: "/api/servers/srv-1" },
  { name: "delete/wrong-method-patch", method: "PATCH", path: "/api/servers/srv-1" },
  { name: "list/after-the-removals", method: "GET", path: "/api/servers" },

  // --- remote directory listings ---------------------------------------------
  // No `path` at all is `.`, and the stub reports what it resolved to.
  { name: "files/no-path", method: "GET", path: "/api/servers/alpha/files" },
  { name: "files/a-blank-path", method: "GET", path: "/api/servers/alpha/files?path=" },
  { name: "files/an-explicit-dot-path", method: "GET", path: "/api/servers/alpha/files?path=." },
  { name: "files/an-absolute-path", method: "GET", path: "/api/servers/alpha/files?path=%2Fsrv%2Fapp" },
  // Hidden entries are filtered by the *client* side of the read, so the same
  // remote answer produces two listings.
  { name: "files/hidden", method: "GET", path: "/api/servers/alpha/files?path=%2Fsrv&hidden=1" },
  { name: "files/hidden-is-zero", method: "GET", path: "/api/servers/alpha/files?path=%2Fsrv&hidden=0" },
  { name: "files/hidden-is-true", method: "GET", path: "/api/servers/alpha/files?path=%2Fsrv&hidden=true" },
  // A path with a quote in it has to survive shell escaping intact.
  {
    name: "files/a-path-with-a-quote",
    method: "GET",
    path: `/api/servers/alpha/files?path=${encodeURIComponent("/srv/it's here")}`,
  },
  {
    name: "files/a-path-with-a-space",
    method: "GET",
    path: `/api/servers/alpha/files?path=${encodeURIComponent("/srv/two words")}`,
  },
  // Not absolute and not `.`, so the read-only guard refuses it — inside the
  // block whose catch is the transport error.
  { name: "files/a-relative-path", method: "GET", path: "/api/servers/alpha/files?path=srv" },
  { name: "files/a-dot-dot-path", method: "GET", path: "/api/servers/alpha/files?path=..%2Fetc" },
  { name: "files/a-null-byte", method: "GET", path: "/api/servers/alpha/files?path=%2Fsrv%00" },
  { name: "files/an-unsafe-host", method: "GET", path: "/api/servers/alpha%3B%20rm/files" },
  { name: "files/an-unreachable-host", method: "GET", path: "/api/servers/dead/files" },
  { name: "files/a-malformed-response", method: "GET", path: "/api/servers/broken/files" },
  { name: "files/a-percent-encoded-host", method: "GET", path: "/api/servers/alpha/files?path=%2Fsrv" },
  { name: "files/wrong-method", method: "POST", path: "/api/servers/alpha/files" },

  // --- remote file previews --------------------------------------------------
  { name: "file/no-path", method: "GET", path: "/api/servers/alpha/file" },
  { name: "file/a-blank-path", method: "GET", path: "/api/servers/alpha/file?path=" },
  { name: "file/a-relative-path", method: "GET", path: "/api/servers/alpha/file?path=etc%2Fhosts" },
  // `.` is accepted by the directory guard and refused by the file one.
  { name: "file/a-dot-path", method: "GET", path: "/api/servers/alpha/file?path=." },
  { name: "file/a-text-file", method: "GET", path: "/api/servers/alpha/file?path=%2Fetc%2Fhosts" },
  { name: "file/a-binary-file", method: "GET", path: "/api/servers/alpha/file?path=%2Fbin%2Fblob" },
  // The header claims a size the body does not have, so `size` and `truncated`
  // cannot both come from the same number.
  { name: "file/a-lying-size", method: "GET", path: "/api/servers/alpha/file?path=%2Fvar%2Flying" },
  { name: "file/a-size-that-is-not-a-number", method: "GET", path: "/api/servers/alpha/file?path=%2Fvar%2Fbadsize" },
  // Genuinely longer than the preview window: the content is cut, the size is not.
  { name: "file/a-large-file", method: "GET", path: "/api/servers/alpha/file?path=%2Fvar%2Fhuge" },
  { name: "file/a-file-that-is-not-there", method: "GET", path: "/api/servers/alpha/file?path=%2Fnope" },
  { name: "file/a-malformed-response", method: "GET", path: "/api/servers/broken/file?path=%2Fetc%2Fhosts" },
  { name: "file/an-unsafe-host", method: "GET", path: "/api/servers/alpha%3B%20rm/file?path=%2Fetc%2Fhosts" },
  { name: "file/an-unreachable-host", method: "GET", path: "/api/servers/dead/file?path=%2Fetc%2Fhosts" },
  { name: "file/wrong-method", method: "POST", path: "/api/servers/alpha/file?path=%2Fetc%2Fhosts" },

  // --- probing ---------------------------------------------------------------
  { name: "probe/a-reachable-host", method: "POST", path: "/api/servers/alpha/probe" },
  // Not a failure status: a 200 carrying the last line of stderr.
  { name: "probe/an-unreachable-host", method: "POST", path: "/api/servers/dead/probe" },
  // The remote answered, but not with the marker.
  { name: "probe/an-unexpected-response", method: "POST", path: "/api/servers/weird/probe" },
  // The only way probe answers with a failure status.
  { name: "probe/an-unsafe-host", method: "POST", path: "/api/servers/alpha%3B%20rm/probe" },
  { name: "probe/a-host-starting-with-a-dash", method: "POST", path: "/api/servers/-oProxy/probe" },
  { name: "probe/a-percent-encoded-host", method: "POST", path: "/api/servers/deploy%4010.0.0.1/probe" },
  { name: "probe/wrong-method", method: "GET", path: "/api/servers/alpha/probe" },

  // --- remote metrics --------------------------------------------------------
  { name: "metrics/a-full-sample", method: "GET", path: "/api/servers/alpha/metrics" },
  // No `NMI_DISK` line at all — `disk` is null rather than zeroed.
  { name: "metrics/no-disk", method: "GET", path: "/api/servers/nodisk/metrics" },
  { name: "metrics/a-missing-section", method: "GET", path: "/api/servers/nometa/metrics" },
  { name: "metrics/a-value-that-is-not-a-number", method: "GET", path: "/api/servers/badnum/metrics" },
  // `NMI_META` is there but carries one field where two are required — a
  // section that is present is not the same as a section that is complete.
  { name: "metrics/a-short-section", method: "GET", path: "/api/servers/shortmeta/metrics" },
  { name: "metrics/an-unreachable-host", method: "GET", path: "/api/servers/dead/metrics" },
  { name: "metrics/an-unsafe-host", method: "GET", path: "/api/servers/alpha%3B%20rm/metrics" },
  { name: "metrics/wrong-method", method: "POST", path: "/api/servers/alpha/metrics" },

  // --- opening a terminal on a server ----------------------------------------
  { name: "terminal/a-discovered-host", method: "POST", path: "/api/servers/beta/terminal" },
  { name: "terminal/a-saved-host", method: "POST", path: "/api/servers/srv-1/terminal" },
  // The label comes from the saved name when there is one.
  { name: "terminal/a-named-host", method: "POST", path: "/api/servers/alpha/terminal" },
  { name: "terminal/an-unknown-host", method: "POST", path: "/api/servers/nowhere/terminal" },
  { name: "terminal/a-percent-encoded-host", method: "POST", path: "/api/servers/deploy%4010.0.0.1/terminal" },
  { name: "terminal/wrong-method", method: "GET", path: "/api/servers/alpha/terminal" },

  // --- the shape of a path that matches nothing ------------------------------
  { name: "shape/a-fourth-segment", method: "GET", path: "/api/servers/alpha/files/more" },
  { name: "shape/an-unknown-third-segment", method: "GET", path: "/api/servers/alpha/nope" },
  { name: "shape/a-trailing-slash", method: "GET", path: "/api/servers/alpha/" },
  { name: "shape/an-empty-host", method: "DELETE", path: "/api/servers//files" },
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
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: parsed,
  };
}

/**
 * A probe's latency, a sample's wall clock, and a terminal session's pid and
 * timestamps are the only values here that cannot be equal by construction.
 * A session's `id` is *not* in this set: `ssh:<host>` is chosen, not generated,
 * and a setup terminal's generated id is handled by `reconcileIds` below.
 */
const VOLATILE = new Set(["latencyMs", "t", "pid", "createdAt", "updatedAt", "lastActiveAt", "startedAt"]);

function scrub(value: unknown): unknown {
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

/**
 * A session created without a chosen id gets a generated one, and
 * `check-terminal-parity.ts` already settled that those are not compared. A
 * *chosen* id is a different thing: `ssh:<host>` is part of the answer this
 * slice gives, so it stays in the diff.
 */
function reconcileIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reconcileIds);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        if (key === "id" && typeof item === "string" && !item.startsWith("ssh:")) {
          return [key, "<generated>"];
        }
        return [key, reconcileIds(item)];
      }),
    );
  }
  return value;
}

function erase(value: string, runtime: Runtime): string {
  return value
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
}

function normalize(answer: Answer, runtime: Runtime): Answer {
  const body = JSON.parse(erase(JSON.stringify(answer.body), runtime));
  return { ...answer, body: reconcileIds(scrub(body)) };
}

const root = await mkdtemp(join(tmpdir(), "nmi-servers-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

async function seed(runtime: Runtime): Promise<void> {
  const ssh = join(runtime.home, ".ssh");
  await mkdir(ssh, { recursive: true });
  await writeFile(join(ssh, "config"), SSH_CONFIG);
  for (const name of PUBLIC_KEYS) await writeFile(join(ssh, name), "ssh-ed25519 AAAA test\n");
  for (const name of SSH_DECOYS) await writeFile(join(ssh, name), "x\n");
  // A *directory* whose name ends in `.pub` is not a public key.
  await mkdir(join(ssh, "archive.pub"), { recursive: true });

  const bin = join(runtime.workspace, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "ssh"), SSH_STUB);
  await chmod(join(bin, "ssh"), 0o755);
  await writeFile(join(bin, "ssh-copy-id"), COPY_ID_STUB);
  await chmod(join(bin, "ssh-copy-id"), 0o755);
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
        sshServers: [],
      }),
      () => [],
    );
    await seed(runtime);
    await harness.startDaemon(runtime, {
      // First, so the stubs win over anything real on this machine — and the
      // rest of PATH is kept so the stubs' own `#!/usr/bin/env node` resolves.
      PATH: `${join(runtime.workspace, "bin")}:${process.env.PATH ?? ""}`,
    });
    const credential = await import("node:fs/promises")
      .then((fs) => fs.readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8"))
      .then((value) => value.trim())
      .catch(() => "");
    credentials.set(runtime, credential);
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
  console.log(`\nservers parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nservers parity: ${steps.length} cases match`);
