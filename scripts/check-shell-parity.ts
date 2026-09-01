/**
 * Phase 6 parity gate for the part of the daemon a *browser* reaches: the SPA
 * shell and the files under `/assets/`.
 *
 * Nothing here reads either implementation. Both runtimes serve the same built
 * client out of `dist/web/client`, so every byte should match; what is actually
 * under test is which paths are pages, which are assets, what each answers when
 * the file is missing, and — the reason for the raw-socket cases below — what
 * happens when a request tries to climb out of the asset root.
 *
 * `fetch` normalizes `..` out of a URL before it leaves the process, so an
 * escape attempt sent that way never reaches the server as one. Those cases go
 * over a raw socket instead, byte for byte.
 *
 * Usage:
 *   node --import tsx scripts/check-shell-parity.ts <candidate> [args...]
 *   ... --dump    print both answers per case
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  repoRoot,
  type Runtime,
} from "../test/support/runtime-parity.js";

interface Case {
  readonly name: string;
  readonly method: "GET" | "HEAD";
  readonly path: string;
  /** Send over a raw socket so the path reaches the server unnormalized. */
  readonly raw?: boolean;
  /**
   * A file under `dist/web/client` this case must serve byte for byte.
   *
   * Set it and the case is checked against that file rather than against the
   * recording. Vite content-hashes asset filenames and `index.html` names
   * them, so a recording of these answers is a snapshot of one dashboard
   * build: rebuild the client and every one of them diverges, reporting a
   * stale recording as a port defect. Nothing about that is parity — "the
   * daemon serves what is in `dist/web/client`" is what these cases always
   * meant, it is the stronger claim, and unlike a recording it stays checkable
   * with no reference to compare against.
   *
   * The cases that stay on the recording are the ones where the *file* is not
   * the answer: a path that climbs out, a percent-encoded dot, a directory,
   * a name nothing built. Those are behaviour, and behaviour is what a
   * recording is for.
   */
  readonly serves?: string;

  /**
   * The document also carries the daemon's credential.
   *
   * Every `/api/*` route is behind a credential and a browser has no other way
   * to learn one, so the shell injects it — which means these cases are no
   * longer the file byte for byte. The claim becomes exactly one step weaker
   * and still checkable without a reference: the daemon serves the file plus
   * one credential script and nothing else. Stripping the script back out and
   * comparing what remains is what enforces the "nothing else".
   */
  readonly injectsCredential?: boolean;
}

/** The one script the shell adds: a frozen global holding the credential. */
const CREDENTIAL_SCRIPT =
  /<script>Object\.defineProperty\(window,'__NOMOREIDE_WEB__',\{value:Object\.freeze\(\{"credential":"[0-9a-f]+"\}\),enumerable:false,configurable:false,writable:false\}\);<\/script>/;

/** The served document with that script removed — which must be the file. */
function withoutCredentialScript(body: Buffer): Buffer {
  return Buffer.from(body.toString("utf8").replace(CREDENTIAL_SCRIPT, ""), "utf8");
}

const dump = process.argv.includes("--dump");
const argv = process.argv.slice(2).filter((value) => value !== "--dump");
if (argv.length === 0) {
  console.error("Usage: check-shell-parity.ts <candidate> [args...]");
  process.exit(2);
}

// A real built asset, so the compare is over actual bytes rather than a name
// both runtimes happen to miss.
const clientDirectory = join(repoRoot(), "dist", "web", "client");
const assetsDirectory = join(clientDirectory, "assets");
const builtAssets = await readdir(assetsDirectory).catch(() => [] as string[]);
if (builtAssets.length === 0) {
  console.error(
    `No built client at ${assetsDirectory}. Run npm run build before this gate.`,
  );
  process.exit(2);
}
const pick = (extension: string) => builtAssets.find((name) => name.endsWith(extension));
const scriptAsset = pick(".js");
const styleAsset = pick(".css");
const fontAsset = pick(".ttf");
const svgAsset = pick(".svg");

const SHELL = "index.html";
const cases: Case[] = [
  { name: "shell/root", method: "GET", path: "/", serves: SHELL, injectsCredential: true },
  { name: "shell/services", method: "GET", path: "/services", serves: SHELL, injectsCredential: true },
  { name: "shell/agent-env", method: "GET", path: "/agent-env", serves: SHELL, injectsCredential: true },
  { name: "shell/extensions", method: "GET", path: "/extensions", serves: SHELL, injectsCredential: true },
  { name: "shell/extension-id", method: "GET", path: "/extensions/some-plugin", serves: SHELL, injectsCredential: true },
  // The bare prefix names no plugin, so it is not a page.
  { name: "shell/extensions-trailing-slash", method: "GET", path: "/extensions/" },
  { name: "shell/unknown-page", method: "GET", path: "/nope" },
  { name: "shell/nested-unknown", method: "GET", path: "/services/extra" },
  { name: "head/root", method: "HEAD", path: "/" },
  { name: "head/services", method: "HEAD", path: "/services" },
  { name: "head/unknown-page", method: "HEAD", path: "/nope" },
  { name: "assets/missing", method: "GET", path: "/assets/definitely-not-here.js" },
  // An asset route registered for GET only: a HEAD is neither page nor asset.
  { name: "assets/head", method: "HEAD", path: `/assets/${scriptAsset}`, serves: SHELL },
  { name: "assets/directory-itself", method: "GET", path: "/assets/" },
  // Percent-encoded dots are a literal directory name, not a climb — both
  // runtimes read the path without decoding it.
  { name: "assets/encoded-dots", method: "GET", path: "/assets/%2e%2e/package.json" },
  { name: "assets/climb-out", method: "GET", path: "/assets/../../../package.json", raw: true },
  {
    name: "assets/sibling-prefix",
    method: "GET",
    path: "/assets/../../client-evil/secret.js",
    raw: true,
  },
  { name: "assets/climb-to-shell-root", method: "GET", path: "/assets/../index.html", raw: true },
];
const asset = (name: string) => join("assets", name);
if (scriptAsset)
  cases.push({ name: "assets/script", method: "GET", path: `/assets/${scriptAsset}`, serves: asset(scriptAsset) });
if (styleAsset)
  cases.push({ name: "assets/style", method: "GET", path: `/assets/${styleAsset}`, serves: asset(styleAsset) });
if (svgAsset)
  cases.push({ name: "assets/svg", method: "GET", path: `/assets/${svgAsset}`, serves: asset(svgAsset) });
// Deliberately absent from the content-type switch on both sides.
if (fontAsset)
  cases.push({ name: "assets/font", method: "GET", path: `/assets/${fontAsset}`, serves: asset(fontAsset) });

// The sibling `dist/web/client-evil/` the escape case reaches for. Without a
// file there both runtimes 404 whatever their containment check does, and the
// case would pass for the wrong reason. Removed again in `finally`.
const sibling = join(repoRoot(), "dist", "web", "client-evil");
await mkdir(sibling, { recursive: true });
await writeFile(join(sibling, "secret.js"), "// must never be served\n");

const root = await mkdtemp(join(tmpdir(), "nmi-shell-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({ version: 1, services: [], bundles: [], gitRepositories: [] }),
      () => [],
    );
    await harness.startDaemon(runtime);
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const testCase of cases) {
    // A case that names a built asset is checked against the file on disk
    // rather than against the recording. The filenames are content-hashed, so
    // the recording froze one build of the dashboard: rebuilding it renames
    // every asset, the recorded answer is filed under a path nobody requests
    // again, and the gate reports a divergence that is really a stale
    // recording. There is no reference left to re-record from, and this is
    // the stronger check anyway — "the daemon serves exactly the bytes in
    // dist/web/client" is what these cases always meant, and it stays true
    // for every future build.
    if (testCase.serves) {
      const answer = await send(candidate, testCase);
      // A HEAD at an asset is the one case here whose answer is not the file:
      // the asset route is registered for GET only, so it falls through to the
      // 404 the reference recorded. That is a fact about the routing table
      // rather than about any particular build, so it is asserted directly.
      const expected =
        testCase.method === "HEAD"
          ? { status: 404, body: digest(Buffer.alloc(0)) }
          : {
              status: 200,
              body: digest(await readFile(join(clientDirectory, testCase.serves))),
            };
      // Take the credential script back out before comparing. What is left has
      // to be the file exactly, so the daemon cannot quietly change anything
      // else about the document it serves.
      const served =
        testCase.injectsCredential && answer.raw
          ? { status: answer.status, body: digest(withoutCredentialScript(answer.raw)) }
          : { status: answer.status, body: answer.body };
      if (testCase.injectsCredential && answer.raw && !CREDENTIAL_SCRIPT.test(answer.raw.toString("utf8"))) {
        failures += 1;
        console.log(`FAIL ${testCase.name}`);
        console.log("  the document carried no credential, so the dashboard cannot authenticate");
        continue;
      }
      try {
        assert.deepStrictEqual(served, expected);
        console.log(`ok   ${testCase.name}`);
      } catch (error) {
        failures += 1;
        console.log(`FAIL ${testCase.name}`);
        console.log(`  served:   ${inspect(answer, { depth: null })}`);
        console.log(`  on disk:  ${inspect(expected, { depth: null })}`);
        console.log(`  ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    const answers = {
      reference: await send(reference, testCase),
      candidate: await send(candidate, testCase),
    };
    if (dump) {
      console.log(`--- ${testCase.name} ---`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
    }
    try {
      assert.deepStrictEqual(answers.candidate, answers.reference);
      console.log(`ok   ${testCase.name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${testCase.name}`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
  await rm(sibling, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? `\nshell parity: ${cases.length} cases match`
    : `\nshell parity: ${failures} case(s) diverged`,
);
process.exit(failures === 0 ? 0 : 1);

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  /** Hashed rather than compared inline: an asset is hundreds of kilobytes,
   * and a diff of two of them is unreadable either way. */
  readonly body: string;
  /** The undigested bytes, kept only where a case has to look inside them —
   * the shell, whose credential script is stripped before comparison. */
  readonly raw?: Buffer;
}

async function send(runtime: Runtime, testCase: Case): Promise<Answer> {
  return testCase.raw ? sendRaw(runtime, testCase) : sendFetch(runtime, testCase);
}

async function sendFetch(runtime: Runtime, testCase: Case): Promise<Answer> {
  // No credential: these are the paths a browser reaches without one, and a
  // gate that sent one would not notice if that stopped being true.
  const response = await fetch(`http://127.0.0.1:${runtime.port}${testCase.path}`, {
    method: testCase.method,
  });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: digest(body),
    raw: body,
  };
}

/** A request written straight onto the socket, so `..` survives the trip. */
function sendRaw(runtime: Runtime, testCase: Case): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(runtime.port, "127.0.0.1", () => {
      socket.write(
        `${testCase.method} ${testCase.path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      );
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const raw = Buffer.concat(chunks);
      const separator = raw.indexOf("\r\n\r\n");
      const head = raw.subarray(0, separator === -1 ? raw.length : separator).toString("utf8");
      const body = separator === -1 ? Buffer.alloc(0) : raw.subarray(separator + 4);
      const lines = head.split("\r\n");
      const status = Number(lines[0]?.split(" ")[1] ?? 0);
      const header = (name: string) =>
        lines
          .slice(1)
          .find((line) => line.toLowerCase().startsWith(`${name}:`))
          ?.split(":")
          .slice(1)
          .join(":")
          .trim() ?? null;
      // Node sets no content-length for a short HTML body and streams it
      // chunked; axum sends the same bytes with a length. Framing is a
      // transport difference, not an answer — decode it away, or every raw
      // case fails on the chunk headers rather than on the content.
      const chunked = header("transfer-encoding")?.toLowerCase().includes("chunked") ?? false;
      resolve({
        status,
        contentType: header("content-type"),
        body: digest(chunked ? dechunk(body) : body),
      });
    });
  });
}

/** Strip HTTP chunked framing: `<hex length>\r\n<payload>\r\n`, ending at 0. */
function dechunk(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < body.byteLength) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString("ascii"), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

function digest(body: Buffer): string {
  return `${body.byteLength}:${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
}
