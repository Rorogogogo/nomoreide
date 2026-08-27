/**
 * Phase 6 parity gate for the Docker surface:
 *
 *   GET  /api/docker/status
 *   POST /api/docker/start
 *   GET  /api/docker/{containers,stats,images,volumes,networks}
 *   GET  /api/docker/containers/:id/{files,file,inspect,logs}
 *   POST /api/docker/containers/:id/{start,stop,restart}
 *
 * Every one of these shells out to `docker`, and the daemon on this machine is
 * down — so the gate plants a **stub `docker`** and a **stub `open`** first on
 * PATH. They answer from the arguments they were handed and from a *mode file*
 * in the runtime's home, which the gate rewrites between steps. That is what
 * makes both halves of a branch reachable inside one fixture: `status` can be
 * asked with the daemon up, with it down, with Docker Desktop missing, and with
 * neither, without provisioning four runtimes.
 *
 * The stubs also **echo their own argv back**, which is the point of several
 * cases:
 *
 * - `logs` prints the `--tail` it received, so the clamp is gated on the value
 *   that actually reached Docker rather than on the shape of the answer. 0,
 *   negative, fractional, absent, unparseable and 5000 all become a specific
 *   number, and they are not all the same number.
 * - `exec` prints the path argument it received. Unlike the SSH reads, this one
 *   is a **separate argv element** rather than text inside a shell command, so
 *   nothing is escaped and a candidate that escapes it anyway diverges.
 *
 * What the cases are watching for:
 *
 * **`/api/docker/containers/:id/pause` is a 404, not a 400.** The route's
 * pattern is `(start|stop|restart)`, so an unknown action never matches it and
 * the handler's own "Unknown action" branch is unreachable. A port that
 * validates the action after matching a wider path answers 400 where the
 * reference answers 404.
 *
 * **Every Docker failure here is a 500** — including the ones the SSH surface
 * calls a 502, and including a path the read-only guard refuses before any
 * process starts. Only `file` without a `path` is a 400.
 *
 * **A malformed line is skipped, not fatal.** Each list parses line by line and
 * drops what it cannot read, or what has no id; one bad row must not blank a
 * view. Each list fixture therefore carries a broken line, a row missing its
 * key field, and a row whose fields are the wrong type.
 *
 * **`docker logs` is two streams merged by timestamp.** stdout and stderr come
 * back separately and are interleaved by sorting the prefixed lines, so the
 * fixture writes them out of order on purpose.
 *
 * **Env values are masked by key shape, and the match is a substring.**
 * `pass|secret|token|key|credential|auth`, case-insensitive, anywhere in the
 * key — so `MONKEY` is masked, because it contains `key`. That is in the
 * fixture on purpose: a port that matches whole words, or anchors the pattern,
 * is *more* sensible and still wrong. Masking only applies to a non-empty
 * value, so an empty `PASSWORD=` stays unmasked and stays `secret: false`.
 *
 * Usage:
 *   node --import tsx scripts/check-docker-parity.ts <candidate> [args...]
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
    "Usage: node --import tsx scripts/check-docker-parity.ts [--dump] <candidate> [args...]",
  );
}

/** Where both stubs read the behaviour the current step wants. */
const MODE_FILE = ".docker-stub-mode";

type Mode = "ok" | "no-daemon" | "no-desktop" | "neither" | "launch-fails" | "list-fails";

/**
 * The stub `docker`.
 *
 * Dispatches on the subcommand, and on the container id for the per-container
 * reads — that is how one container is missing, another answers garbage, and a
 * third works. Output that has to carry NUL bytes is written as a Buffer.
 */
const DOCKER_STUB = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const mode = (() => {
  try {
    return fs.readFileSync(path.join(process.env.HOME || "", ".docker-stub-mode"), "utf8").trim();
  } catch {
    return "ok";
  }
})();

function out(value) {
  process.stdout.write(typeof value === "string" ? Buffer.from(value, "utf8") : value);
  process.exit(0);
}
function die(message, code) {
  process.stderr.write(message);
  process.exit(code === undefined ? 1 : code);
}
const NUL = Buffer.from([0]);
function nul(...parts) {
  return Buffer.concat(
    parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(String(part), "utf8"))),
  );
}

// --- version ---------------------------------------------------------------
if (args[0] === "version") {
  if (mode === "no-daemon" || mode === "neither") {
    die("Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\nIs the docker daemon running?\n");
  }
  out("27.3.1\n");
}

// --- the list reads --------------------------------------------------------
const LISTS = {
  ps: [
    // A full row, with compose labels.
    '{"ID":"abc123456789","Names":"web","Image":"nginx:1.27","State":"running","Status":"Up 2 hours","Ports":"0.0.0.0:8080->80/tcp","CreatedAt":"2026-01-01 10:00:00 +0000 UTC","Labels":"com.docker.compose.project=shop,com.docker.compose.service=web,other=1"}',
    // No Names: the id stands in for the name.
    '{"ID":"def123456789","Image":"postgres:16","State":"exited","Status":"Exited (0) 3 days ago","Ports":"","Labels":""}',
    // Wrong types throughout, and a label entry with no "=" in it.
    '{"ID":"ghi123456789","Names":7,"Image":null,"State":"","Status":false,"Ports":[],"Labels":"bare,=novalue,trailing="}',
    // No ID at all: dropped.
    '{"Names":"orphan","Image":"busybox"}',
    "   ",
    "{ this is not json",
    // An empty Names is falsy, so the id stands in here too.
    '{"ID":"jkl123456789","Names":"","Image":"redis","State":"paused","Status":"Paused","Ports":"","Labels":"com.docker.compose.project=shop"}',
  ],
  stats: [
    '{"ID":"abc123456789","CPUPerc":"2.43%","MemPerc":"11.20%","MemUsage":"184MiB / 2GiB","NetIO":"1.2kB / 648B","BlockIO":"0B / 4.1kB"}',
    // "--" is Docker's no-sample value, and becomes null rather than zero.
    '{"ID":"def123456789","CPUPerc":"--","MemPerc":"--","MemUsage":"-- / --","NetIO":"--","BlockIO":"--"}',
    // No ID, but a Container: the fallback key.
    '{"Container":"ghi123456789","CPUPerc":"0.00%","MemPerc":"0.05%","MemUsage":"1MiB / 2GiB","NetIO":"0B / 0B","BlockIO":"0B / 0B"}',
    // Neither key: dropped.
    '{"CPUPerc":"9.99%"}',
    "not json at all",
  ],
  images: [
    '{"ID":"sha256:aaa","Repository":"nginx","Tag":"1.27","Size":"187MB","CreatedSince":"2 weeks ago"}',
    // Untagged leftovers are dangling, by either half.
    '{"ID":"sha256:bbb","Repository":"<none>","Tag":"<none>","Size":"417MB","CreatedSince":"3 months ago"}',
    '{"ID":"sha256:ccc","Repository":"app","Tag":"<none>","Size":"1.2GB","CreatedSince":"1 hour ago"}',
    '{"ID":"sha256:ddd","Repository":"<none>","Tag":"latest","Size":"90MB","CreatedSince":"1 day ago"}',
    '{"Repository":"no-id","Tag":"v1"}',
    "}{",
  ],
  volumes: [
    '{"Name":"shop_db","Driver":"local","Mountpoint":"/var/lib/docker/volumes/shop_db/_data","Scope":"local"}',
    '{"Name":"cache","Driver":"local","Mountpoint":"","Scope":"local"}',
    '{"Driver":"local","Mountpoint":"/nowhere"}',
    '{"Name":123,"Driver":"local"}',
  ],
  networks: [
    '{"ID":"net111111","Name":"bridge","Driver":"bridge","Scope":"local"}',
    '{"ID":"net222222","Name":"shop_default","Driver":"bridge","Scope":"local"}',
    '{"Name":"no-id","Driver":"host"}',
  ],
};

function list(rows) {
  if (mode === "list-fails") {
    die("Error response from daemon: something went wrong\n");
  }
  out(rows.join("\n") + "\n");
}

if (args[0] === "ps") list(LISTS.ps);
if (args[0] === "stats") list(LISTS.stats);
if (args[0] === "images") list(LISTS.images);
if (args[0] === "volume" && args[1] === "ls") list(LISTS.volumes);
if (args[0] === "network" && args[1] === "ls") list(LISTS.networks);

// --- lifecycle actions -----------------------------------------------------
if (args[0] === "start" || args[0] === "stop" || args[0] === "restart") {
  if (args[1] === "broken") die("Error response from daemon: no such container\n");
  out("");
}

// --- logs ------------------------------------------------------------------
if (args[0] === "logs") {
  const tail = args[args.indexOf("--tail") + 1];
  const id = args[args.length - 1];
  if (id === "broken") die("Error response from daemon: no such container\n");
  // Deliberately out of order, and split across the two streams, so the merge
  // has something to do.
  process.stdout.write(
    "2026-01-01T10:00:02.000000000Z out second\n" +
      "2026-01-01T10:00:00.000000000Z out first tail=" + tail + "\n" +
      "\n" +
      "2026-01-01T10:00:05.000000000Z out last\n",
  );
  process.stderr.write(
    "2026-01-01T10:00:01.000000000Z err early\n" +
      "2026-01-01T10:00:03.000000000Z err middle\n",
  );
  process.exit(0);
}

// --- inspect ---------------------------------------------------------------
const INSPECT = {
  "abc123456789": [
    {
      Id: "abc123456789abcdef",
      Name: "/web",
      Created: "2026-01-01T10:00:00.000000000Z",
      RestartCount: 3,
      Config: {
        Image: "nginx:1.27",
        Entrypoint: "/docker-entrypoint.sh",
        Cmd: ["nginx", "-g", "daemon off;", 7],
        Env: [
          "PATH=/usr/local/sbin",
          "DB_PASSWORD=hunter2",
          "api_key=abcdef",
          "MY_TOKEN=xyz",
          "OAUTH_CREDENTIAL=c",
          "SOME_AUTHORITY=a",
          // Contains "key". Masked, and that is the reference's behaviour.
          "MONKEY=banana",
          "EMPTY_PASSWORD=",
          "NOEQUALS",
        ],
        Labels: { "com.docker.compose.project": "shop", broken: 5 },
      },
      State: { Status: "running", StartedAt: "2026-01-01T10:00:01.000000000Z" },
      NetworkSettings: {
        Ports: {
          "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }, { HostIp: "", HostPort: "9090" }],
          "443/tcp": null,
          "9999/tcp": [],
        },
        Networks: { bridge: {}, shop_default: {} },
      },
      Mounts: [
        { Type: "volume", Name: "shop_db", Source: "/var/lib/x", Destination: "/data", RW: true },
        { Type: "bind", Source: "/host/conf", Destination: "/etc/conf", RW: false },
        "not a mount",
      ],
    },
  ],
  // A bare object rather than the array docker actually returns.
  "def123456789": {
    Id: "def123456789abcdef",
    Name: "db",
    Config: {},
    State: {},
    NetworkSettings: {},
  },
  // An empty array: parsed fine, but there is no document in it.
  "empty": [],
  "notjson": "{{{",
};

if (args[0] === "inspect") {
  const id = args[1];
  if (id === "broken") die("Error: No such object: broken\n");
  const document = INSPECT[id];
  if (document === undefined) die("Error: No such object: " + id + "\n");
  out(typeof document === "string" ? document : JSON.stringify(document));
}

// --- exec: the read-only file protocol -------------------------------------
if (args[0] === "exec") {
  const id = args[1];
  if (id === "broken") die("Error response from daemon: no such container\n");
  // argv is: exec <id> sh -c <script> nomoreide <path>
  const script = args[4] || "";
  const requested = args[6] === undefined ? "<no-path-argument>" : args[6];

  if (script.includes("NMI_PATH")) {
    const resolved = requested === "." ? "/app" : requested;
    const entries = [
      ["server.js", "f", "1024", "1700000000.5"],
      ["Static", "d", "4096", "1700000001.0"],
      ["assets", "d", "4096", "1700000002.25"],
      [".env", "f", "64", "1700000003.0"],
      ["éclair.txt", "f", "9", "1700000004.0"],
      ["eclair.txt", "f", "7", "1700000005.0"],
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

  if (script.includes("NMI_FILE")) {
    if (requested === "/nope") die("Path is not a regular file.\n");
    if (requested === "/bin/blob") {
      out(nul("NMI_FILE", NUL, "4", NUL, Buffer.from([0x00, 0x01, 0x02, 0x03])));
    }
    const body = "the path was: " + requested + "\n";
    out(nul("NMI_FILE", NUL, String(Buffer.byteLength(body)), NUL, body));
  }
  die("stub docker: unrecognised exec script\n");
}

die("stub docker: unrecognised command " + args.join(" ") + "\n", 125);
`;

/**
 * The stub `open`.
 *
 * `-Ra Docker` is the "is Docker Desktop installed" probe and `-a Docker` is
 * the launch. Both are refused in the modes that say so, which is how the
 * install and launch failures become reachable.
 */
const OPEN_STUB = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let mode = "ok";
try {
  mode = fs.readFileSync(path.join(process.env.HOME || "", ".docker-stub-mode"), "utf8").trim();
} catch {}

if (args[0] === "-Ra") {
  if (mode === "no-desktop" || mode === "neither") {
    process.stderr.write("Unable to find application named 'Docker'\n");
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === "-a") {
  if (mode === "no-desktop" || mode === "neither") {
    process.stderr.write("Unable to find application named 'Docker'\n");
    process.exit(1);
  }
  if (mode === "launch-fails") {
    process.stderr.write("The application cannot be opened.\n");
    process.exit(1);
  }
  process.exit(0);
}
process.exit(0);
`;

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  readonly path: string;
  /** Written to both runtimes' mode files before the request. */
  readonly mode?: Mode;
}

const steps: readonly Step[] = [
  // --- whether Docker is there at all ----------------------------------------
  { name: "status/available", method: "GET", path: "/api/docker/status" },
  // The daemon is down: `available` is false and the error is Node's whole
  // `Command failed:` sentence, not just the stderr.
  { name: "status/no-daemon", method: "GET", path: "/api/docker/status", mode: "no-daemon" },
  // Desktop is missing but the CLI works — `canStart` false, and an install
  // link appears that is absent when it is installed.
  { name: "status/no-desktop", method: "GET", path: "/api/docker/status", mode: "no-desktop" },
  { name: "status/neither", method: "GET", path: "/api/docker/status", mode: "neither" },
  { name: "status/wrong-method", method: "POST", path: "/api/docker/status", mode: "ok" },

  // --- launching Docker Desktop ----------------------------------------------
  { name: "start/ok", method: "POST", path: "/api/docker/start" },
  { name: "start/not-installed", method: "POST", path: "/api/docker/start", mode: "no-desktop" },
  // Installed, but the launch itself fails.
  { name: "start/launch-fails", method: "POST", path: "/api/docker/start", mode: "launch-fails" },
  { name: "start/wrong-method", method: "GET", path: "/api/docker/start", mode: "ok" },

  // --- the list reads --------------------------------------------------------
  { name: "containers/list", method: "GET", path: "/api/docker/containers" },
  { name: "containers/wrong-method", method: "POST", path: "/api/docker/containers" },
  { name: "stats/list", method: "GET", path: "/api/docker/stats" },
  { name: "stats/wrong-method", method: "POST", path: "/api/docker/stats" },
  { name: "images/list", method: "GET", path: "/api/docker/images" },
  { name: "images/wrong-method", method: "DELETE", path: "/api/docker/images" },
  { name: "volumes/list", method: "GET", path: "/api/docker/volumes" },
  { name: "volumes/wrong-method", method: "POST", path: "/api/docker/volumes" },
  { name: "networks/list", method: "GET", path: "/api/docker/networks" },
  { name: "networks/wrong-method", method: "PUT", path: "/api/docker/networks" },

  // Every list reports a CLI failure the same way, and it is a 500.
  { name: "containers/a-failure", method: "GET", path: "/api/docker/containers", mode: "list-fails" },
  { name: "stats/a-failure", method: "GET", path: "/api/docker/stats", mode: "list-fails" },
  { name: "images/a-failure", method: "GET", path: "/api/docker/images", mode: "list-fails" },
  { name: "volumes/a-failure", method: "GET", path: "/api/docker/volumes", mode: "list-fails" },
  { name: "networks/a-failure", method: "GET", path: "/api/docker/networks", mode: "list-fails" },

  // --- listing inside a container --------------------------------------------
  { name: "files/no-path", method: "GET", path: "/api/docker/containers/abc123456789/files", mode: "ok" },
  { name: "files/a-blank-path", method: "GET", path: "/api/docker/containers/abc123456789/files?path=" },
  { name: "files/an-explicit-dot", method: "GET", path: "/api/docker/containers/abc123456789/files?path=." },
  { name: "files/an-absolute-path", method: "GET", path: "/api/docker/containers/abc123456789/files?path=%2Fsrv%2Fapp" },
  { name: "files/hidden", method: "GET", path: "/api/docker/containers/abc123456789/files?path=%2Fapp&hidden=1" },
  { name: "files/hidden-is-zero", method: "GET", path: "/api/docker/containers/abc123456789/files?path=%2Fapp&hidden=0" },
  // A separate argv element, so nothing is escaped and the quote arrives whole.
  {
    name: "files/a-path-with-a-quote",
    method: "GET",
    path: `/api/docker/containers/abc123456789/files?path=${encodeURIComponent("/app/it's here")}`,
  },
  {
    name: "files/a-path-with-a-space",
    method: "GET",
    path: `/api/docker/containers/abc123456789/files?path=${encodeURIComponent("/app/two words")}`,
  },
  // The read-only guard refuses before anything is spawned, and it is still a
  // 500 — this surface has no other failure status.
  { name: "files/a-relative-path", method: "GET", path: "/api/docker/containers/abc123456789/files?path=app" },
  { name: "files/a-null-byte", method: "GET", path: "/api/docker/containers/abc123456789/files?path=%2Fapp%00" },
  { name: "files/an-unsafe-id", method: "GET", path: "/api/docker/containers/abc%3B%20rm/files" },
  { name: "files/an-id-starting-with-a-dash", method: "GET", path: "/api/docker/containers/-rm/files" },
  { name: "files/a-container-that-fails", method: "GET", path: "/api/docker/containers/broken/files" },
  { name: "files/wrong-method", method: "POST", path: "/api/docker/containers/abc123456789/files" },

  // --- previewing a file inside a container ----------------------------------
  // The one 400 on this surface.
  { name: "file/no-path", method: "GET", path: "/api/docker/containers/abc123456789/file" },
  { name: "file/a-blank-path", method: "GET", path: "/api/docker/containers/abc123456789/file?path=" },
  { name: "file/a-dot-path", method: "GET", path: "/api/docker/containers/abc123456789/file?path=." },
  { name: "file/a-relative-path", method: "GET", path: "/api/docker/containers/abc123456789/file?path=app%2Fx" },
  { name: "file/a-text-file", method: "GET", path: "/api/docker/containers/abc123456789/file?path=%2Fapp%2Fserver.js" },
  { name: "file/a-binary-file", method: "GET", path: "/api/docker/containers/abc123456789/file?path=%2Fbin%2Fblob" },
  { name: "file/a-file-that-is-not-there", method: "GET", path: "/api/docker/containers/abc123456789/file?path=%2Fnope" },
  { name: "file/an-unsafe-id", method: "GET", path: "/api/docker/containers/abc%3B%20rm/file?path=%2Fx" },
  { name: "file/wrong-method", method: "POST", path: "/api/docker/containers/abc123456789/file?path=%2Fx" },

  // --- the detail panel ------------------------------------------------------
  { name: "inspect/a-container", method: "GET", path: "/api/docker/containers/abc123456789/inspect" },
  // Docker returns an array; a bare object is accepted too.
  { name: "inspect/a-bare-object", method: "GET", path: "/api/docker/containers/def123456789/inspect" },
  // Parses, but there is no document in it.
  { name: "inspect/an-empty-array", method: "GET", path: "/api/docker/containers/empty/inspect" },
  { name: "inspect/not-json", method: "GET", path: "/api/docker/containers/notjson/inspect" },
  { name: "inspect/an-unknown-container", method: "GET", path: "/api/docker/containers/zzz999999999/inspect" },
  { name: "inspect/an-unsafe-id", method: "GET", path: "/api/docker/containers/abc%3B%20rm/inspect" },
  { name: "inspect/a-percent-encoded-id", method: "GET", path: "/api/docker/containers/abc123456789/inspect" },
  { name: "inspect/wrong-method", method: "POST", path: "/api/docker/containers/abc123456789/inspect" },

  // --- lifecycle -------------------------------------------------------------
  { name: "action/start", method: "POST", path: "/api/docker/containers/abc123456789/start" },
  { name: "action/stop", method: "POST", path: "/api/docker/containers/abc123456789/stop" },
  { name: "action/restart", method: "POST", path: "/api/docker/containers/abc123456789/restart" },
  // The alternation is in the *path*, so an action nobody implements matches no
  // route at all — a 404, never the handler's "Unknown action".
  { name: "action/an-unknown-action", method: "POST", path: "/api/docker/containers/abc123456789/pause" },
  { name: "action/kill", method: "POST", path: "/api/docker/containers/abc123456789/kill" },
  { name: "action/an-unsafe-id", method: "POST", path: "/api/docker/containers/abc%3B%20rm/start" },
  { name: "action/a-container-that-fails", method: "POST", path: "/api/docker/containers/broken/stop" },
  { name: "action/wrong-method", method: "GET", path: "/api/docker/containers/abc123456789/start" },

  // --- logs ------------------------------------------------------------------
  // The stub prints back the `--tail` it was given, so each of these asserts
  // the number that actually reached Docker.
  { name: "logs/no-tail", method: "GET", path: "/api/docker/containers/abc123456789/logs" },
  { name: "logs/a-tail", method: "GET", path: "/api/docker/containers/abc123456789/logs?tail=50" },
  { name: "logs/tail-is-zero", method: "GET", path: "/api/docker/containers/abc123456789/logs?tail=0" },
  { name: "logs/tail-is-negative", method: "GET", path: "/api/docker/containers/abc123456789/logs?tail=-5" },
  { name: "logs/tail-is-fractional", method: "GET", path: "/api/docker/containers/abc123456789/logs?tail=1.9" },
  { name: "logs/tail-is-not-a-number", method: "GET", path: "/api/docker/containers/abc123456789/logs?tail=abc" },
  { name: "logs/tail-is-blank", method: "GET", path: "/api/docker/containers/abc123456789/logs?tail=" },
  { name: "logs/tail-is-huge", method: "GET", path: "/api/docker/containers/abc123456789/logs?tail=5000" },
  { name: "logs/tail-is-exactly-the-cap", method: "GET", path: "/api/docker/containers/abc123456789/logs?tail=2000" },
  { name: "logs/an-unsafe-id", method: "GET", path: "/api/docker/containers/abc%3B%20rm/logs" },
  { name: "logs/a-container-that-fails", method: "GET", path: "/api/docker/containers/broken/logs" },
  { name: "logs/wrong-method", method: "POST", path: "/api/docker/containers/abc123456789/logs" },

  // --- paths that match nothing ----------------------------------------------
  { name: "shape/a-bare-container", method: "GET", path: "/api/docker/containers/abc123456789" },
  { name: "shape/an-unknown-third-segment", method: "GET", path: "/api/docker/containers/abc123456789/nope" },
  { name: "shape/a-fifth-segment", method: "GET", path: "/api/docker/containers/abc123456789/files/more" },
  { name: "shape/an-empty-id", method: "GET", path: "/api/docker/containers//files" },
  { name: "shape/an-unknown-docker-path", method: "GET", path: "/api/docker/nope" },
  { name: "shape/a-trailing-slash", method: "GET", path: "/api/docker/containers/abc123456789/logs/" },
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
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers,
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

function erase(value: string, runtime: Runtime): string {
  return value
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
}

function normalize(answer: Answer, runtime: Runtime): Answer {
  return { ...answer, body: JSON.parse(erase(JSON.stringify(answer.body), runtime)) };
}

const root = await mkdtemp(join(tmpdir(), "nmi-docker-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

async function seed(runtime: Runtime): Promise<void> {
  const bin = join(runtime.workspace, "bin");
  await mkdir(bin, { recursive: true });
  for (const [name, source] of [
    ["docker", DOCKER_STUB],
    ["open", OPEN_STUB],
  ] as const) {
    await writeFile(join(bin, name), source);
    await chmod(join(bin, name), 0o755);
  }
  await writeFile(join(runtime.home, MODE_FILE), "ok\n");
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
    await harness.startDaemon(runtime, {
      // First, so the stubs win over anything real — and the rest of PATH is
      // kept so their `#!/usr/bin/env node` still resolves.
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

  let mode: Mode = "ok";
  for (const step of steps) {
    if (step.mode && step.mode !== mode) {
      mode = step.mode;
      for (const runtime of runtimes) {
        await writeFile(join(runtime.home, MODE_FILE), `${mode}\n`);
      }
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
  console.log(`\ndocker parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\ndocker parity: ${steps.length} cases match`);
