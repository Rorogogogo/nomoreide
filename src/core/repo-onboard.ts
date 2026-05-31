import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import yaml from "js-yaml";
import { z } from "zod";

const execFileAsync = promisify(execFile);

/**
 * Onboard a repository from just a URL: clone it, scan it into a structured
 * {@link RepoProfile}, and heuristically propose how to install + run it as a
 * managed service. The reasoning here is deterministic and read-safe; an AI
 * agent can read the profile and refine the proposal (the "hybrid" brain).
 *
 * Cloning lives here rather than in GitManager on purpose — GitManager stays
 * read-safe (no network writes / no clone), so the additive clone-into-a-fresh
 * -dir operation is guarded in this dedicated module instead.
 */

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

export interface ParsedRepoUrl {
  /** Sanitised service name derived from the repo path. */
  name: string;
  /** The URL as given (trimmed), suitable to hand to `git clone`. */
  normalizedUrl: string;
  owner?: string;
  host?: string;
}

const UNSAFE_NAME = /[^a-zA-Z0-9._-]+/g;
const SCP_LIKE = /^(?:[\w.-]+@)?([\w.-]+):(.+)$/;

function sanitizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(UNSAFE_NAME, "-")
    .replace(/^-+|-+$/g, "");
}

/** Parse https / ssh / scp-style git URLs and derive a safe service name. */
export function parseRepoUrl(input: string): ParsedRepoUrl {
  const url = input.trim();
  if (!url) throw new Error("Repository URL is required.");

  let host: string | undefined;
  let path: string;

  if (/^[a-zA-Z][\w+.-]*:\/\//.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid repository URL: ${input}`);
    }
    if (!["http:", "https:", "ssh:", "git:", "file:"].includes(parsed.protocol)) {
      throw new Error(`Unsupported repository URL scheme: ${parsed.protocol}`);
    }
    host = parsed.host;
    path = parsed.pathname;
  } else {
    const scp = SCP_LIKE.exec(url);
    if (!scp) throw new Error(`Unrecognized repository URL: ${input}`);
    host = scp[1];
    path = scp[2];
  }

  const segments = path
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`Repository URL has no path: ${input}`);
  }
  const repo = segments[segments.length - 1];
  const owner = segments.length >= 2 ? segments[segments.length - 2] : undefined;
  const name = sanitizeName(repo);
  if (!name) {
    throw new Error(`Could not derive a service name from URL: ${input}`);
  }
  return { name, normalizedUrl: url, owner, host };
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

/** Where onboarded repos are cloned. Override with `NOMOREIDE_REPOS_DIR`. */
export function defaultReposDir(): string {
  const override = process.env.NOMOREIDE_REPOS_DIR?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".nomoreide", "repos");
}

/** True when `path` resolves inside `root` (containment guard for endpoints). */
export function isInsideReposDir(path: string, root = defaultReposDir()): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" ? false : !rel.startsWith("..") && !resolve(path).includes("\0");
}

async function isNonEmptyDir(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface CloneResult {
  name: string;
  clonePath: string;
  url: string;
}

/**
 * Shallow-clone a repository into `destRoot/<name>`. Refuses to overwrite a
 * non-empty destination, and disables interactive credential prompts so a
 * private repo fails fast instead of hanging.
 */
export async function cloneRepository(
  url: string,
  destRoot: string = defaultReposDir(),
): Promise<CloneResult> {
  const parsed = parseRepoUrl(url);
  const clonePath = join(destRoot, parsed.name);
  if (await isNonEmptyDir(clonePath)) {
    throw new Error(
      `Destination already exists and is not empty: ${clonePath}. Remove it or pick another repo.`,
    );
  }
  await mkdir(destRoot, { recursive: true });
  await execFileAsync(
    "git",
    ["clone", "--depth", "1", parsed.normalizedUrl, clonePath],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  return { name: parsed.name, clonePath, url: parsed.normalizedUrl };
}

// ---------------------------------------------------------------------------
// Scan → RepoProfile
// ---------------------------------------------------------------------------

const nodeSignalSchema = z.object({
  packageManager: z.enum(["npm", "yarn", "pnpm", "bun"]),
  scripts: z.record(z.string()),
  hasDevScript: z.boolean(),
  hasStartScript: z.boolean(),
});

const pythonSignalSchema = z.object({
  hasRequirements: z.boolean(),
  hasPyproject: z.boolean(),
  hasManagePy: z.boolean(),
  framework: z.enum(["django", "fastapi", "flask", "unknown"]),
});

const composeServiceDetailSchema = z.object({
  name: z.string(),
  image: z.string().optional(),
  ports: z.array(z.string()),
  environment: z.record(z.string()),
});
export type ComposeServiceDetail = z.infer<typeof composeServiceDetailSchema>;

const dockerSignalSchema = z.object({
  hasDockerfile: z.boolean(),
  composeFile: z.string().optional(),
  composeServices: z.array(z.string()),
  /** Per-service compose details (image/ports/env), used for DB detection. */
  services: z.array(composeServiceDetailSchema).optional(),
});

export const repoProfileSchema = z.object({
  name: z.string(),
  clonePath: z.string(),
  languages: z.array(z.string()),
  node: nodeSignalSchema.optional(),
  python: pythonSignalSchema.optional(),
  docker: dockerSignalSchema.optional(),
  /** Env var names from `.env.example` (values intentionally dropped). */
  envKeys: z.array(z.string()),
  readmeExcerpt: z.string().optional(),
});
export type RepoProfile = z.infer<typeof repoProfileSchema>;

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function detectPackageManager(files: Set<string>): "npm" | "yarn" | "pnpm" | "bun" {
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("bun.lockb")) return "bun";
  return "npm";
}

async function scanNode(
  clonePath: string,
  files: Set<string>,
): Promise<z.infer<typeof nodeSignalSchema> | undefined> {
  if (!files.has("package.json")) return undefined;
  const raw = await readTextIfPresent(join(clonePath, "package.json"));
  let scripts: Record<string, string> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
      if (parsed.scripts && typeof parsed.scripts === "object") {
        scripts = parsed.scripts;
      }
    } catch {
      // malformed package.json — treat as scriptless
    }
  }
  return {
    packageManager: detectPackageManager(files),
    scripts,
    hasDevScript: typeof scripts.dev === "string",
    hasStartScript: typeof scripts.start === "string",
  };
}

async function scanPython(
  clonePath: string,
  files: Set<string>,
): Promise<z.infer<typeof pythonSignalSchema> | undefined> {
  const hasRequirements = files.has("requirements.txt");
  const hasPyproject = files.has("pyproject.toml");
  const hasManagePy = files.has("manage.py");
  if (!hasRequirements && !hasPyproject && !hasManagePy) return undefined;

  let framework: "django" | "fastapi" | "flask" | "unknown" = "unknown";
  if (hasManagePy) {
    framework = "django";
  } else {
    const deps =
      (await readTextIfPresent(join(clonePath, "requirements.txt")))?.toLowerCase() ??
      (await readTextIfPresent(join(clonePath, "pyproject.toml")))?.toLowerCase() ??
      "";
    if (deps.includes("fastapi") || deps.includes("uvicorn")) framework = "fastapi";
    else if (deps.includes("flask")) framework = "flask";
    else if (deps.includes("django")) framework = "django";
  }
  return { hasRequirements, hasPyproject, hasManagePy, framework };
}

const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

async function scanDocker(
  clonePath: string,
  files: Set<string>,
): Promise<z.infer<typeof dockerSignalSchema> | undefined> {
  const composeFile = COMPOSE_FILES.find((file) => files.has(file));
  const hasDockerfile = files.has("Dockerfile");
  if (!composeFile && !hasDockerfile) return undefined;

  let composeServices: string[] = [];
  let services: ComposeServiceDetail[] = [];
  if (composeFile) {
    const raw = await readTextIfPresent(join(clonePath, composeFile));
    if (raw) {
      services = parseComposeServiceDetails(raw);
      composeServices = services.map((service) => service.name);
    }
  }
  return { hasDockerfile, composeFile, composeServices, services };
}

/** Parse top-level compose services with the details we use downstream. */
export function parseComposeServiceDetails(raw: string): ComposeServiceDetail[] {
  try {
    const doc = yaml.load(raw) as { services?: Record<string, unknown> } | null;
    const services = doc?.services;
    if (!services || typeof services !== "object") return [];
    return Object.entries(services).map(([name, def]) => {
      const service = (def ?? {}) as Record<string, unknown>;
      return {
        name,
        image: typeof service.image === "string" ? service.image : undefined,
        ports: normalizeComposePorts(service.ports),
        environment: normalizeComposeEnvironment(service.environment),
      };
    });
  } catch {
    // fall through to empty list on malformed YAML
  }
  return [];
}

/** Extract top-level service names from a compose file. */
export function parseComposeServices(raw: string): string[] {
  return parseComposeServiceDetails(raw).map((service) => service.name);
}

/** Normalize compose `ports` (short string, number, or long object form) to strings. */
function normalizeComposePorts(ports: unknown): string[] {
  if (!Array.isArray(ports)) return [];
  const out: string[] = [];
  for (const entry of ports) {
    if (typeof entry === "number") out.push(String(entry));
    else if (typeof entry === "string") out.push(entry);
    else if (entry && typeof entry === "object") {
      const target = (entry as Record<string, unknown>).target;
      const published = (entry as Record<string, unknown>).published;
      if (published != null && target != null) out.push(`${published}:${target}`);
      else if (target != null) out.push(String(target));
    }
  }
  return out;
}

/** Normalize compose `environment` (map or `KEY=value` list) to a record. */
function normalizeComposeEnvironment(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(env)) {
    for (const item of env) {
      if (typeof item !== "string") continue;
      const eq = item.indexOf("=");
      if (eq > 0) out[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
    }
  } else if (env && typeof env === "object") {
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      out[key] = value == null ? "" : String(value);
    }
  }
  return out;
}

function parseEnvKeys(raw: string): string[] {
  const keys: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (match) keys.push(match[1]);
  }
  return keys;
}

const README_FILES = ["README.md", "readme.md", "README.MD", "README"];
const README_HEADING = /^#{1,3}\s+.*(getting started|usage|quick\s?start|running|setup|develop|install)/i;

function extractReadmeExcerpt(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => README_HEADING.test(line));
  const slice = start >= 0 ? lines.slice(start, start + 40) : lines.slice(0, 30);
  return slice.join("\n").slice(0, 2000).trim();
}

/** Read-only scan of a cloned repo into a structured profile. */
export async function scanRepo(clonePath: string): Promise<RepoProfile> {
  const entries = await readdir(clonePath).catch(() => {
    throw new Error(`Cannot scan repository at ${clonePath}.`);
  });
  const files = new Set(entries);

  const [node, python, docker] = await Promise.all([
    scanNode(clonePath, files),
    scanPython(clonePath, files),
    scanDocker(clonePath, files),
  ]);

  let envKeys: string[] = [];
  for (const candidate of [".env.example", ".env.sample", ".env.template"]) {
    if (files.has(candidate)) {
      const raw = await readTextIfPresent(join(clonePath, candidate));
      if (raw) {
        envKeys = parseEnvKeys(raw);
        break;
      }
    }
  }

  let readmeExcerpt: string | undefined;
  const readmeName = README_FILES.find((file) => files.has(file));
  if (readmeName) {
    const raw = await readTextIfPresent(join(clonePath, readmeName));
    if (raw) readmeExcerpt = extractReadmeExcerpt(raw);
  }

  const languages: string[] = [];
  if (node) languages.push("node");
  if (python) languages.push("python");
  if (docker) languages.push("docker");

  return {
    name: sanitizeName(clonePath.split(/[\\/]/).filter(Boolean).pop() ?? "service"),
    clonePath,
    languages,
    node,
    python,
    docker,
    envKeys,
    readmeExcerpt,
  };
}

// ---------------------------------------------------------------------------
// Heuristic proposals
// ---------------------------------------------------------------------------

export const proposedServiceSchema = z.object({
  name: z.string(),
  kind: z.enum(["local", "docker-compose"]),
  command: z.string().optional(),
  cwd: z.string(),
  port: z.number().int().positive().max(65535).optional(),
  env: z.record(z.string()).optional(),
  description: z.string().optional(),
  composeFile: z.string().optional(),
  composeService: z.string().optional(),
  /** One-shot install step to run before first start (not persisted). */
  installCommand: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string(),
});
export type ProposedService = z.infer<typeof proposedServiceSchema>;

const PORT_PATTERNS = [
  /--port[ =](\d{2,5})/i,
  /-p[ =](\d{2,5})/i,
  /\bport[ =:](\d{2,5})/i,
  /:(\d{4,5})\b/,
];

function sniffPort(text: string): number | undefined {
  for (const pattern of PORT_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const port = Number(match[1]);
      if (port >= 1 && port <= 65535) return port;
    }
  }
  return undefined;
}

function runScript(pm: "npm" | "yarn" | "pnpm" | "bun", script: string): string {
  switch (pm) {
    case "pnpm":
      return `pnpm ${script}`;
    case "yarn":
      return `yarn ${script}`;
    case "bun":
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

function installCmd(pm: "npm" | "yarn" | "pnpm" | "bun"): string {
  switch (pm) {
    case "pnpm":
      return "pnpm install";
    case "yarn":
      return "yarn install";
    case "bun":
      return "bun install";
    default:
      return "npm install";
  }
}

/**
 * Best-effort service proposals, ordered most-confident first. Docker Compose
 * is the strongest signal (run command + ports are declared), so a compose
 * repo yields one proposal per service; Node/Python yield a single proposal.
 */
export function proposeServices(profile: RepoProfile): ProposedService[] {
  const proposals: ProposedService[] = [];
  const { clonePath, name } = profile;

  if (profile.docker?.composeFile && profile.docker.composeServices.length > 0) {
    const services = profile.docker.composeServices;
    const details = profile.docker.services ?? [];
    const primary =
      services.find((service) => sanitizeName(service) === name) ?? services[0];
    for (const service of services) {
      const detail = details.find((entry) => entry.name === service);
      proposals.push({
        name: service === primary ? name : `${name}-${sanitizeName(service)}`,
        kind: "docker-compose",
        cwd: clonePath,
        composeFile: profile.docker.composeFile,
        composeService: service,
        // Published host port (left side of a `5433:5432` mapping), not container.
        port: detail ? firstHostPort(detail.ports) : undefined,
        confidence: service === primary ? "high" : "low",
        reason: `docker-compose service "${service}"`,
      });
    }
  }

  if (profile.node) {
    const { packageManager, scripts, hasDevScript, hasStartScript } = profile.node;
    const script = hasDevScript ? "dev" : hasStartScript ? "start" : undefined;
    if (script) {
      proposals.push({
        name,
        kind: "local",
        command: runScript(packageManager, script),
        cwd: clonePath,
        port: sniffPort(scripts[script] ?? ""),
        installCommand: installCmd(packageManager),
        confidence: hasDevScript ? "high" : "medium",
        reason: `package.json "${script}" script (${packageManager})`,
      });
    }
  }

  if (profile.python) {
    const command = pythonCommand(profile.python);
    proposals.push({
      name,
      kind: "local",
      command,
      cwd: clonePath,
      port: defaultPythonPort(profile.python),
      installCommand: profile.python.hasRequirements
        ? "pip install -r requirements.txt"
        : profile.python.hasPyproject
          ? "pip install ."
          : undefined,
      confidence: profile.python.framework === "unknown" ? "low" : "medium",
      reason: `python ${profile.python.framework} project`,
    });
  }

  return dedupeByName(proposals).sort(
    (a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence),
  );
}

function pythonCommand(python: z.infer<typeof pythonSignalSchema>): string {
  switch (python.framework) {
    case "django":
      return "python manage.py runserver";
    case "fastapi":
      return "uvicorn main:app --reload";
    case "flask":
      return "flask run";
    default:
      return "python main.py";
  }
}

function defaultPythonPort(python: z.infer<typeof pythonSignalSchema>): number | undefined {
  if (python.framework === "django") return 8000;
  if (python.framework === "fastapi") return 8000;
  if (python.framework === "flask") return 5000;
  return undefined;
}

function confidenceRank(confidence: ProposedService["confidence"]): number {
  return confidence === "high" ? 2 : confidence === "medium" ? 1 : 0;
}

function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    result.push(item);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Database proposals (auto-register a DB when a compose service is one)
// ---------------------------------------------------------------------------

export const proposedDatabaseSchema = z.object({
  name: z.string(),
  engine: z.enum(["postgres", "mysql"]),
  url: z.string(),
  composeService: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string(),
});
export type ProposedDatabase = z.infer<typeof proposedDatabaseSchema>;

interface DbImageMatch {
  engine: "postgres" | "mysql";
  defaultPort: number;
}

/** Recognise common database container images. */
function detectDbImage(image?: string): DbImageMatch | undefined {
  if (!image) return undefined;
  if (/postgres|pgvector|postgis|timescale/i.test(image)) {
    return { engine: "postgres", defaultPort: 5432 };
  }
  if (/mysql|mariadb|percona/i.test(image)) {
    return { engine: "mysql", defaultPort: 3306 };
  }
  return undefined;
}

/**
 * Propose a registrable DB connection for each compose service backed by a known
 * database image — host port from the published mapping, credentials from the
 * service environment. This is what lets onboarding light up the Database tab.
 */
export function proposeDatabases(profile: RepoProfile): ProposedDatabase[] {
  const details = profile.docker?.services ?? [];
  const proposals: ProposedDatabase[] = [];
  for (const service of details) {
    const match = detectDbImage(service.image);
    if (!match) continue;
    const hostPort = publishedHostPort(service.ports, match.defaultPort) ?? match.defaultPort;
    const { user, password, database } = dbCredentials(match.engine, service.environment);
    proposals.push({
      name: `${profile.name}-db`,
      engine: match.engine,
      url: buildDbUrl(match.engine, user, password, hostPort, database),
      composeService: service.name,
      confidence: database ? "high" : "medium",
      reason: `${match.engine} database from compose service "${service.name}"${
        service.image ? ` (${service.image})` : ""
      }`,
    });
  }
  return dedupeByName(proposals);
}

/** The host port published for `containerPort` (e.g. 5433 from "5433:5432"). */
function publishedHostPort(ports: string[], containerPort: number): number | undefined {
  for (const entry of ports) {
    const parts = entry.split(":");
    if (parts.length < 2) continue;
    const container = Number(parts[parts.length - 1].replace(/\/.*$/, ""));
    const published = Number(parts[parts.length - 2]);
    if (container === containerPort && Number.isFinite(published)) return published;
  }
  return firstHostPort(ports);
}

/** The host port of the first published mapping (left side of `host:container`). */
function firstHostPort(ports: string[]): number | undefined {
  for (const entry of ports) {
    const parts = entry.split(":");
    const raw = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    const value = Number(String(raw).replace(/\/.*$/, ""));
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function dbCredentials(
  engine: "postgres" | "mysql",
  env: Record<string, string>,
): { user: string; password: string; database: string } {
  if (engine === "postgres") {
    const user = env.POSTGRES_USER ?? "postgres";
    return { user, password: env.POSTGRES_PASSWORD ?? "", database: env.POSTGRES_DB ?? user };
  }
  return {
    user: env.MYSQL_USER ?? "root",
    password: env.MYSQL_PASSWORD ?? env.MYSQL_ROOT_PASSWORD ?? "",
    database: env.MYSQL_DATABASE ?? "",
  };
}

function buildDbUrl(
  engine: "postgres" | "mysql",
  user: string,
  password: string,
  port: number,
  database: string,
): string {
  const scheme = engine === "mysql" ? "mysql" : "postgres";
  const auth = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);
  return `${scheme}://${auth}@127.0.0.1:${port}/${database}`;
}

// ---------------------------------------------------------------------------
// One-shot streamed install runner (used by the structured wizard route)
// ---------------------------------------------------------------------------

export interface InstallLine {
  stream: "stdout" | "stderr";
  text: string;
}

export interface InstallResult {
  exitCode: number | null;
}

/**
 * Run a one-shot install command in `cwd`, streaming each output line to
 * `onLine`. Modeled on the TestRunner spawn pattern (shell + line buffering)
 * but stateless — the caller (an SSE route) owns delivery.
 */
export function runInstall(options: {
  cwd: string;
  command: string;
  onLine?: (line: InstallLine) => void;
}): Promise<InstallResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const buffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
    const emit = (stream: "stdout" | "stderr", text: string) => {
      if (text.trim()) options.onLine?.({ stream, text });
    };
    const onChunk = (stream: "stdout" | "stderr") => (chunk: Buffer | string) => {
      buffers[stream] += chunk.toString();
      const lines = buffers[stream].split(/\r?\n/);
      buffers[stream] = lines.pop() ?? "";
      for (const line of lines) emit(stream, line);
    };
    child.stdout?.on("data", onChunk("stdout"));
    child.stderr?.on("data", onChunk("stderr"));
    child.once("error", (error) => {
      emit("stderr", error.message);
      resolvePromise({ exitCode: null });
    });
    child.once("exit", (exitCode) => {
      emit("stdout", buffers.stdout);
      emit("stderr", buffers.stderr);
      resolvePromise({ exitCode });
    });
  });
}
