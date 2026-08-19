import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isSensitiveConnectionParameter } from "./db-peek.js";
import type { DatabaseConnection, DatabaseEngine, ServiceDefinition } from "./types.js";

const MAX_FILES = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
const SESSION_TTL_MS = 10 * 60 * 1000;

export interface JetBrainsRunPreview {
  id: string;
  name: string;
  runType: string;
  source: string;
  command: string;
  args?: string[];
  cwd: string;
  envKeys: string[];
  conflict: boolean;
}

export interface UnsupportedJetBrainsRun {
  name: string;
  runType: string;
  source: string;
  reason: string;
}

export interface JetBrainsImportPreview {
  sessionId: string;
  projectRoot: string;
  candidates: JetBrainsRunPreview[];
  unsupported: UnsupportedJetBrainsRun[];
  databases: JetBrainsDatabasePreview[];
  unsupportedDatabases: UnsupportedJetBrainsDatabase[];
  expiresAt: string;
}

export interface JetBrainsDatabasePreview {
  id: string;
  name: string;
  engine: DatabaseEngine;
  source: string;
  host?: string;
  port?: number;
  database?: string;
  path?: string;
  username?: string;
  conflict: boolean;
}

export interface UnsupportedJetBrainsDatabase {
  name: string;
  source: string;
  reason: string;
}

export interface JetBrainsDatabaseSelection {
  id: string;
  conflict: "add" | "skip" | "replace" | "rename";
  name?: string;
  username?: string;
  password?: string;
  test?: boolean;
}

export interface JetBrainsImportSelection {
  id: string;
  conflict: "add" | "skip" | "replace" | "rename";
  name?: string;
  command?: string;
  args?: string[];
  cwd?: string;
}

export interface JetBrainsImportService {
  definition: ServiceDefinition;
  onConflict: "error" | "replace";
}

export interface JetBrainsImportDatabase {
  definition: DatabaseConnection;
  onConflict: "error" | "replace";
  test: boolean;
}

interface PrivateCandidate {
  id: string;
  runType: string;
  source: string;
  definition: ServiceDefinition;
}

interface ImportSession {
  projectRoot: string;
  candidates: PrivateCandidate[];
  unsupported: UnsupportedJetBrainsRun[];
  databases: PrivateDatabaseCandidate[];
  unsupportedDatabases: UnsupportedJetBrainsDatabase[];
  expiresAt: number;
}

interface PrivateDatabaseCandidate {
  id: string;
  source: string;
  definition: DatabaseConnection;
  username?: string;
}

export class JetBrainsImportSessions {
  private readonly sessions = new Map<string, ImportSession>();

  async scan(options: {
    projectRoot: string;
    includePersonal: boolean;
    existingNames: string[];
    existingDatabaseNames?: string[];
  }): Promise<JetBrainsImportPreview> {
    this.prune();
    const projectRoot = await realpath(options.projectRoot);
    if (!(await stat(projectRoot)).isDirectory()) {
      throw new Error("Project root must be a directory.");
    }
    const files = await knownRunConfigurationFiles(projectRoot, options.includePersonal);
    const candidates: PrivateCandidate[] = [];
    const unsupported: UnsupportedJetBrainsRun[] = [];
    let totalBytes = 0;

    for (const file of files) {
      const metadata = await stat(file.path);
      if (!metadata.isFile()) continue;
      if (metadata.size > MAX_FILE_BYTES) {
        unsupported.push({
          name: file.source,
          runType: "file",
          source: file.source,
          reason: "File exceeds the 2 MB import limit.",
        });
        continue;
      }
      totalBytes += metadata.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("JetBrains configuration files exceed the 6 MB import limit.");
      }
      const xml = await readFile(file.path, "utf8");
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
        unsupported.push({
          name: file.source,
          runType: "file",
          source: file.source,
          reason: "DTD and entity declarations are not allowed.",
        });
        continue;
      }
      for (const configuration of extractConfigurations(xml)) {
        const parsed = await adaptConfiguration(configuration, projectRoot, file.source);
        if ("definition" in parsed) candidates.push(parsed);
        else unsupported.push(parsed);
      }
    }

    const databaseScan = await scanDataSources(projectRoot);
    if (totalBytes + databaseScan.bytes > MAX_TOTAL_BYTES) {
      throw new Error("JetBrains configuration files exceed the 6 MB import limit.");
    }

    const sessionId = randomUUID();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const session = {
      projectRoot,
      candidates,
      unsupported,
      databases: databaseScan.candidates,
      unsupportedDatabases: databaseScan.unsupported,
      expiresAt,
    };
    this.sessions.set(sessionId, session);
    return this.preview(
      sessionId,
      session,
      new Set(options.existingNames),
      new Set(options.existingDatabaseNames ?? []),
    );
  }

  async consume(
    sessionId: string,
    selections: JetBrainsImportSelection[],
    databaseSelections: JetBrainsDatabaseSelection[] = [],
  ): Promise<{ services: JetBrainsImportService[]; databases: JetBrainsImportDatabase[] }> {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Import preview expired. Scan the project again.");
    const byId = new Map(session.candidates.map((candidate) => [candidate.id, candidate]));
    const names = new Set<string>();
    const services: JetBrainsImportService[] = [];

    for (const selection of selections) {
      const candidate = byId.get(selection.id);
      if (!candidate) throw new Error(`Unknown import candidate: ${selection.id}`);
      if (selection.conflict === "skip") continue;
      const requestedName =
        selection.conflict === "rename" ? selection.name?.trim() : candidate.definition.name;
      if (!requestedName) throw new Error("Renamed services require a name.");
      if (names.has(requestedName)) {
        throw new Error(`Import contains duplicate service name: ${requestedName}`);
      }
      names.add(requestedName);
      const command = selection.command?.trim() || candidate.definition.command;
      if (!command) throw new Error("Imported services require a command.");
      const cwd = selection.cwd?.trim() || candidate.definition.cwd || session.projectRoot;
      const normalizedCwd = await canonicalProjectPath(cwd, session.projectRoot);
      if (!normalizedCwd) {
        throw new Error(`Imported working directory escapes the project: ${cwd}`);
      }
      services.push({
        definition: {
          ...candidate.definition,
          name: requestedName,
          command,
          cwd: normalizedCwd,
          ...(selection.args === undefined ? {} : { args: selection.args }),
        },
        onConflict: selection.conflict === "replace" ? "replace" : "error",
      });
    }
    const databaseById = new Map(session.databases.map((candidate) => [candidate.id, candidate]));
    const databaseNames = new Set<string>();
    const databases: JetBrainsImportDatabase[] = [];
    for (const selection of databaseSelections) {
      const candidate = databaseById.get(selection.id);
      if (!candidate) throw new Error(`Unknown database import candidate: ${selection.id}`);
      if (selection.conflict === "skip") continue;
      const name = selection.conflict === "rename" ? selection.name?.trim() : candidate.definition.name;
      if (!name) throw new Error("Renamed database connections require a name.");
      if (databaseNames.has(name)) throw new Error(`Import contains duplicate database name: ${name}`);
      databaseNames.add(name);
      const definition = databaseDefinition(candidate, selection, name);
      databases.push({
        definition,
        onConflict: selection.conflict === "replace" ? "replace" : "error",
        test: selection.test === true,
      });
    }
    return { services, databases };
  }

  complete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private preview(
    sessionId: string,
    session: ImportSession,
    existingNames: Set<string>,
    existingDatabaseNames: Set<string>,
  ): JetBrainsImportPreview {
    return {
      sessionId,
      projectRoot: session.projectRoot,
      candidates: session.candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.definition.name,
        runType: candidate.runType,
        source: candidate.source,
        command: candidate.definition.command ?? "",
        ...(candidate.definition.args === undefined ? {} : { args: candidate.definition.args }),
        cwd: candidate.definition.cwd ?? session.projectRoot,
        envKeys: Object.keys(candidate.definition.env ?? {}).sort(),
        conflict: existingNames.has(candidate.definition.name),
      })),
      unsupported: session.unsupported,
      databases: session.databases.map((candidate) =>
        databasePreview(candidate, existingDatabaseNames),
      ),
      unsupportedDatabases: session.unsupportedDatabases,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}

interface KnownFile {
  path: string;
  source: string;
}

async function scanDataSources(projectRoot: string): Promise<{
  candidates: PrivateDatabaseCandidate[];
  unsupported: UnsupportedJetBrainsDatabase[];
  bytes: number;
}> {
  const requested = join(projectRoot, ".idea", "dataSources.xml");
  let path: string;
  try {
    path = await realpath(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { candidates: [], unsupported: [], bytes: 0 };
    }
    throw error;
  }
  assertInside(projectRoot, path);
  const metadata = await stat(path);
  if (!metadata.isFile()) return { candidates: [], unsupported: [], bytes: 0 };
  if (metadata.size > MAX_FILE_BYTES) {
    return {
      candidates: [],
      unsupported: [{
        name: "dataSources.xml",
        source: ".idea/dataSources.xml",
        reason: "File exceeds the 2 MB import limit.",
      }],
      bytes: metadata.size,
    };
  }
  const xml = await readFile(path, "utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    return {
      candidates: [],
      unsupported: [{
        name: "dataSources.xml",
        source: ".idea/dataSources.xml",
        reason: "DTD and entity declarations are not allowed.",
      }],
      bytes: metadata.size,
    };
  }

  const candidates: PrivateDatabaseCandidate[] = [];
  const unsupported: UnsupportedJetBrainsDatabase[] = [];
  for (const match of xml.matchAll(/<data-source\b([^>]*)>([\s\S]*?)<\/data-source>/gi)) {
    const attributes = attributesOf(match[1] ?? "");
    const body = match[2] ?? "";
    const name = attributes.name || "Unnamed data source";
    const source = ".idea/dataSources.xml";
    const jdbcUrl = tagText(body, "jdbc-url");
    const driver = tagText(body, "driver-ref") ?? tagText(body, "jdbc-driver") ?? "";
    if (!jdbcUrl) {
      unsupported.push({ name, source, reason: "JDBC URL is missing." });
      continue;
    }
    const parsed = await parseJdbcDatabase(name, jdbcUrl, driver, projectRoot);
    if ("reason" in parsed) unsupported.push({ name, source, reason: parsed.reason });
    else candidates.push({ id: randomUUID(), source, ...parsed });
  }
  return { candidates, unsupported, bytes: metadata.size };
}

async function parseJdbcDatabase(
  name: string,
  jdbcUrl: string,
  driver: string,
  projectRoot: string,
): Promise<Omit<PrivateDatabaseCandidate, "id" | "source"> | { reason: string }> {
  if (/sqlite/i.test(driver) || jdbcUrl.startsWith("jdbc:sqlite:")) {
    const rawPath = jdbcUrl.replace(/^jdbc:sqlite:/i, "");
    const expanded = rawPath
      .replaceAll("$PROJECT_DIR$", projectRoot)
      .replaceAll("$ProjectFileDir$", projectRoot);
    const path = await canonicalProjectPath(expanded, projectRoot);
    if (!path) return { reason: "SQLite path resolves outside the project." };
    return {
      definition: {
        name,
        engine: "sqlite",
        url: path,
        writeUnlocked: false,
        projectPath: projectRoot,
      },
    };
  }

  const engine: DatabaseEngine | undefined =
    /postgres/i.test(driver) || jdbcUrl.startsWith("jdbc:postgresql:")
      ? "postgres"
      : /mysql/i.test(driver) || jdbcUrl.startsWith("jdbc:mysql:")
        ? "mysql"
        : undefined;
  if (!engine) return { reason: "Only PostgreSQL, MySQL, and SQLite data sources are supported." };
  try {
    const url = new URL(jdbcUrl.replace(/^jdbc:/i, ""));
    const username = decodeURIComponent(url.username || url.searchParams.get("user") || "");
    url.username = username;
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:user|username)$/i.test(key) || isSensitiveConnectionParameter(key)) {
        url.searchParams.delete(key);
      }
    }
    return {
      definition: {
        name,
        engine,
        url: url.toString(),
        writeUnlocked: false,
        projectPath: projectRoot,
      },
      ...(username ? { username } : {}),
    };
  } catch {
    return { reason: "JDBC URL is invalid." };
  }
}

function databasePreview(
  candidate: PrivateDatabaseCandidate,
  existingNames: Set<string>,
): JetBrainsDatabasePreview {
  const base = {
    id: candidate.id,
    name: candidate.definition.name,
    engine: candidate.definition.engine,
    source: candidate.source,
    conflict: existingNames.has(candidate.definition.name),
  };
  if (candidate.definition.engine === "sqlite") {
    return { ...base, path: candidate.definition.url };
  }
  const url = new URL(candidate.definition.url);
  return {
    ...base,
    host: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    database: url.pathname.replace(/^\//, ""),
    ...(candidate.username ? { username: candidate.username } : {}),
  };
}

function databaseDefinition(
  candidate: PrivateDatabaseCandidate,
  selection: JetBrainsDatabaseSelection,
  name: string,
): DatabaseConnection {
  if (candidate.definition.engine === "sqlite") {
    return { ...candidate.definition, name, writeUnlocked: false };
  }
  const username = selection.username?.trim() || candidate.username || "";
  const password = selection.password ?? "";
  if (!username) throw new Error(`Username is required for database "${name}".`);
  if (!password) throw new Error(`Password is required for database "${name}".`);
  const url = new URL(candidate.definition.url);
  url.username = username;
  url.password = password;
  return { ...candidate.definition, name, url: url.toString(), writeUnlocked: false };
}

function tagText(body: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(body);
  const value = match ? decodeXml(match[1] ?? "").trim() : "";
  return value || undefined;
}

async function knownRunConfigurationFiles(
  projectRoot: string,
  includePersonal: boolean,
): Promise<KnownFile[]> {
  const requested: string[] = [];
  for (const directory of [join(projectRoot, ".run"), join(projectRoot, ".idea", "runConfigurations")]) {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const supportedName = directory.endsWith(`${sep}.run`)
        ? entry.name.endsWith(".run.xml")
        : entry.name.endsWith(".xml");
      if ((entry.isFile() || entry.isSymbolicLink()) && supportedName) {
        requested.push(join(directory, entry.name));
      }
    }
  }
  if (includePersonal) requested.push(join(projectRoot, ".idea", "workspace.xml"));
  if (requested.length > MAX_FILES) throw new Error(`Found more than ${MAX_FILES} JetBrains config files.`);

  const files: KnownFile[] = [];
  for (const requestedPath of requested) {
    let canonical: string;
    try {
      canonical = await realpath(requestedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    assertInside(projectRoot, canonical);
    files.push({ path: canonical, source: relative(projectRoot, requestedPath) });
  }
  return files.sort((left, right) => left.source.localeCompare(right.source));
}

interface XmlConfiguration {
  name: string;
  type: string;
  body: string;
  options: Record<string, string>;
  env: Record<string, string>;
}

function extractConfigurations(xml: string): XmlConfiguration[] {
  const configurations: XmlConfiguration[] = [];
  const pattern = /<configuration\b([^>]*)>([\s\S]*?)<\/configuration>/gi;
  for (const match of xml.matchAll(pattern)) {
    const attributes = attributesOf(match[1] ?? "");
    const body = match[2] ?? "";
    const options: Record<string, string> = {};
    for (const option of body.matchAll(/<option\b([^>]*)\/?\s*>/gi)) {
      const attrs = attributesOf(option[1] ?? "");
      if (attrs.name && attrs.value !== undefined) options[attrs.name] = attrs.value;
    }
    const env: Record<string, string> = {};
    for (const entry of body.matchAll(/<env\b([^>]*)\/?\s*>/gi)) {
      const attrs = attributesOf(entry[1] ?? "");
      if (attrs.name && attrs.value !== undefined && isEnvKey(attrs.name)) {
        env[attrs.name] = attrs.value;
      }
    }
    configurations.push({
      name: attributes.name || "Unnamed configuration",
      type: attributes.type || attributes.factoryName || "unknown",
      body,
      options,
      env,
    });
  }
  return configurations;
}

function attributesOf(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of input.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    result[match[1] as string] = decodeXml(match[3] ?? "");
  }
  return result;
}

async function adaptConfiguration(
  config: XmlConfiguration,
  projectRoot: string,
  source: string,
): Promise<PrivateCandidate | UnsupportedJetBrainsRun> {
  const unsupported = (reason: string): UnsupportedJetBrainsRun => ({
    name: config.name,
    runType: config.type,
    source,
    reason,
  });
  const cwd = await canonicalProjectPath(
    option(config, "workingDirectory", "WORKING_DIRECTORY", "working-dir", "externalProjectPath") ??
      projectRoot,
    projectRoot,
  );
  if (!cwd) return unsupported("Working directory resolves outside the project.");

  let definition: ServiceDefinition | undefined;
  if (/npm/i.test(config.type)) {
    const script =
      option(config, "scripts", "scriptName", "SCRIPT_NAME") ??
      firstTagAttribute(config.body, "script", "value");
    if (!script) return unsupported("npm script name is missing.");
    const packageJson = option(config, "package-json", "packageJson");
    const packageCwd = packageJson
      ? await canonicalProjectPath(
          dirname(expandProjectPath(packageJson, projectRoot)),
          projectRoot,
        )
      : cwd;
    if (!packageCwd) return unsupported("package.json resolves outside the project.");
    definition = localDefinition(config, "npm", ["run", script], packageCwd);
  } else if (/NodeJSConfigurationType|node\.js/i.test(config.type)) {
    const script = option(config, "path-to-js-file", "pathToJsFile", "JS_FILE");
    if (!script) return unsupported("Node entry file is missing.");
    const scriptPath = await canonicalProjectPath(script, projectRoot);
    if (!scriptPath) return unsupported("Node entry file resolves outside the project.");
    definition = localDefinition(config, "node", [scriptPath, ...tokenize(option(config, "application-parameters", "applicationParameters") ?? "")], cwd);
  } else if (/ShConfigurationType|Shell Script/i.test(config.type)) {
    const text = option(config, "SCRIPT_TEXT", "scriptText");
    const path = option(config, "SCRIPT_PATH", "scriptPath");
    if (text) definition = { ...localDefinition(config, text, undefined, cwd), args: undefined };
    else if (path) {
      const scriptPath = await canonicalProjectPath(path, projectRoot);
      if (!scriptPath) return unsupported("Shell script resolves outside the project.");
      definition = localDefinition(config, "/bin/sh", [scriptPath, ...tokenize(option(config, "SCRIPT_OPTIONS") ?? "")], cwd);
    } else return unsupported("Shell script text or path is missing.");
  } else if (/MavenRunConfiguration/i.test(config.type)) {
    const goals = option(config, "goals", "commandLine");
    if (!goals) return unsupported("Maven goals are missing.");
    definition = localDefinition(config, "mvn", tokenize(goals), cwd);
  } else if (/GradleRunConfiguration/i.test(config.type)) {
    const tasks = listOption(config.body, "taskNames");
    if (tasks.length === 0) return unsupported("Gradle task names are missing.");
    let wrapper = "gradle";
    if (await fileExists(join(projectRoot, "gradlew"))) {
      const wrapperPath = await canonicalProjectPath(join(projectRoot, "gradlew"), projectRoot);
      if (!wrapperPath) return unsupported("Gradle wrapper resolves outside the project.");
      wrapper = wrapperPath;
    }
    definition = localDefinition(config, wrapper, tasks, cwd);
  } else if (/CargoCommandRunConfiguration/i.test(config.type)) {
    const command = option(config, "command");
    if (!command) return unsupported("Cargo command is missing.");
    definition = localDefinition(config, "cargo", tokenize(command), cwd);
  } else {
    return unsupported("This JetBrains run configuration type is not supported.");
  }

  return { id: randomUUID(), runType: config.type, source, definition };
}

function localDefinition(
  config: XmlConfiguration,
  command: string,
  args: string[] | undefined,
  cwd: string,
): ServiceDefinition {
  return {
    name: config.name,
    command,
    ...(args === undefined ? {} : { args }),
    cwd,
    ...(Object.keys(config.env).length > 0 ? { env: config.env } : {}),
    description: `Imported from JetBrains (${config.type})`,
  };
}

function option(config: XmlConfiguration, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = config.options[name];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function listOption(body: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<option\\b[^>]*name=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/option>`, "i").exec(body);
  if (!match) return [];
  return [...(match[1] ?? "").matchAll(/<option\b([^>]*)\/?\s*>/gi)]
    .map((entry) => attributesOf(entry[1] ?? "").value)
    .filter((value): value is string => Boolean(value));
}

function firstTagAttribute(
  body: string,
  tag: string,
  attribute: string,
): string | undefined {
  const match = new RegExp(`<${tag}\\b([^>]*)\\/?\\s*>`, "i").exec(body);
  return match ? attributesOf(match[1] ?? "")[attribute] : undefined;
}

async function canonicalProjectPath(
  value: string,
  projectRoot: string,
): Promise<string | undefined> {
  const expanded = expandProjectPath(value, projectRoot);
  const target = resolve(isAbsolute(expanded) ? expanded : join(projectRoot, expanded));
  if (!isInside(projectRoot, target)) return undefined;

  let existing = target;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(existing);
      if (!isInside(projectRoot, canonical)) return undefined;
      const normalized = resolve(canonical, ...missingSegments.reverse());
      return isInside(projectRoot, normalized) ? normalized : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (existing === projectRoot) return undefined;
      missingSegments.push(basename(existing));
      existing = dirname(existing);
    }
  }
}

function expandProjectPath(value: string, projectRoot: string): string {
  return value
    .replaceAll("$PROJECT_DIR$", projectRoot)
    .replaceAll("$MODULE_WORKING_DIR$", projectRoot);
}

function tokenize(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") escaped = true;
    else if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
    } else current += char;
  }
  if (quote) throw new Error("Run configuration contains an unterminated quoted argument.");
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function isEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertInside(root: string, target: string): void {
  if (!isInside(root, target)) throw new Error("JetBrains config path escapes the project root.");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
