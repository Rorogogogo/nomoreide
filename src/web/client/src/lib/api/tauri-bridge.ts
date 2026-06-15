/**
 * Tauri IPC bridge — maps Rust command responses to the shapes the React
 * components already expect. Loaded lazily so the web version pays no cost.
 */

import { isTauri } from "@/lib/tauri";

// Lazy-loaded to avoid bundling tauri APIs in the web build.
let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
let _listen: ((event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>) | null = null;

async function getInvoke() {
  if (!_invoke) {
    const mod = await import("@tauri-apps/api/core");
    _invoke = mod.invoke as typeof _invoke;
  }
  return _invoke!;
}

async function getListen() {
  if (!_listen) {
    const mod = await import("@tauri-apps/api/event");
    _listen = mod.listen as typeof _listen;
  }
  return _listen!;
}

export async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = await getInvoke();
  return invoke(command, args) as Promise<T>;
}

export async function tauriListen(
  event: string,
  handler: (payload: unknown) => void,
): Promise<() => void> {
  const listen = await getListen();
  return listen(event, (e) => handler(e.payload));
}

// ---------------------------------------------------------------------------
// Type adapters: map Rust camelCase output → TypeScript interface shapes
// ---------------------------------------------------------------------------

export interface RustServiceStatus {
  name: string;
  state: "Stopped" | "Starting" | "Running" | "Stopping";
  pid: number | null;
  exitCode: number | null;
  url: string | null;
}

export interface RustDashboardData {
  config: {
    version: number;
    services: unknown[];
    bundles: unknown[];
    gitRepositories: unknown[];
    selectedGitRepository: string | null;
    gitBoardRepositories: string[] | null;
    databases: unknown[];
    logSources: unknown[];
    githubTokens: unknown[];
    workflows: unknown[];
  };
  runtime: {
    services: RustServiceStatus[];
  };
}

function adaptServiceStatus(s: RustServiceStatus) {
  return {
    name: s.name,
    state: s.state.toLowerCase() as "stopped" | "starting" | "running",
    pid: s.pid ?? undefined,
    exitCode: s.exitCode ?? null,
    url: s.url ?? undefined,
  };
}

export function adaptDashboard(raw: RustDashboardData) {
  const servicesRecord: Record<string, ReturnType<typeof adaptServiceStatus>> = {};
  for (const s of raw.runtime.services) {
    servicesRecord[s.name] = adaptServiceStatus(s);
  }
  return {
    ok: true as const,
    cwd: "",
    config: {
      services: raw.config.services,
      bundles: raw.config.bundles,
      gitRepositories: raw.config.gitRepositories,
      selectedGitRepository: raw.config.selectedGitRepository ?? undefined,
      gitBoardRepositories: raw.config.gitBoardRepositories ?? undefined,
    },
    runtime: { services: servicesRecord },
    ports: [],
    health: {},
    timeline: [],
    logs: [],
    git: {
      cwd: "",
      selectedRepository: null,
      status: null,
      branches: [],
    },
  };
}

export interface RustGitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  email: string;
  date: string;
  refs: string[];
  parents: string[];
}

export function adaptGitGraph(commits: RustGitCommit[]) {
  return commits.map((c, i) => ({
    hash: c.hash,
    parents: c.parents,
    author: c.author,
    email: c.email,
    timestamp: new Date(c.date).getTime() / 1000,
    subject: c.subject,
    refs: c.refs.map((r) => ({
      name: r,
      kind: r.startsWith("HEAD") ? "head" as const
          : r.startsWith("origin/") || r.includes("/") ? "remote" as const
          : "branch" as const,
    })),
    // Lane layout is a complex graph algorithm — for now assign monotonically.
    // A proper lane-layout pass can be added as a follow-up.
    lane: 0,
    laneCount: 1,
    edges: [],
    throughLanes: [],
  }));
}

export interface RustGitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

export function adaptBranches(branches: RustGitBranch[]) {
  return branches.map((b) => ({
    name: b.name,
    current: b.isCurrent,
    remote: b.isRemote,
  }));
}

export interface RustGitStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: Array<{ path: string; index: string; workingTree: string }>;
}

// ---------------------------------------------------------------------------
// Tauri-mode replacements for each API module
// ---------------------------------------------------------------------------

// ---- Dashboard / Services ----

export async function tauri_getDashboard() {
  const raw = await tauriInvoke<RustDashboardData>("get_dashboard");
  return adaptDashboard(raw);
}

export async function tauri_startService(name: string) {
  await tauriInvoke("start_service", { name });
}

export async function tauri_stopService(name: string) {
  await tauriInvoke("stop_service", { name });
}

export async function tauri_restartService(name: string) {
  await tauriInvoke("restart_service", { name });
}

export async function tauri_startBundle(name: string) {
  await tauriInvoke("start_bundle", { name });
}

export async function tauri_stopBundle(name: string) {
  await tauriInvoke("stop_bundle", { name });
}

export async function tauri_deleteService(name: string) {
  await tauriInvoke("remove_service", { name });
}

export async function tauri_registerService(service: unknown) {
  return tauriInvoke("register_service", { service });
}

export async function tauri_registerBundle(bundle: { name: string; services: string[] }) {
  return tauriInvoke("register_bundle", { bundle });
}

export async function tauri_getServiceLogs(service: string, limit?: number) {
  const entries = await tauriInvoke<unknown[]>("get_logs", { service, limit: limit ?? 200 });
  return { logs: entries, queryable: false };
}

// ---- Git ----

export async function tauri_gitStatus(repo?: string) {
  return tauriInvoke<RustGitStatus>("git_status", { repo: repo ?? null });
}

export async function tauri_gitDiff(file?: string, repo?: string) {
  return tauriInvoke<string>("git_diff", { file: file ?? null, repo: repo ?? null });
}

export async function tauri_gitGraph(limit = 200) {
  const commits = await tauriInvoke<RustGitCommit[]>("git_graph", { limit, repo: null });
  return adaptGitGraph(commits);
}

export async function tauri_gitCommitDiff(hash: string, file?: string) {
  return tauriInvoke<string>("git_commit_diff", { hash, file: file ?? null, repo: null });
}

export async function tauri_gitCommitFiles(hash: string) {
  const files = await tauriInvoke<Array<{ path: string; index: string; workingTree: string }>>(
    "git_commit_files", { hash, repo: null },
  );
  return files;
}

export async function tauri_gitStage(paths: string[], repo?: string) {
  await tauriInvoke("git_stage", { paths, repo: repo ?? null });
}

export async function tauri_gitUnstage(paths: string[], repo?: string) {
  await tauriInvoke("git_unstage", { paths, repo: repo ?? null });
}

export async function tauri_gitCommit(message: string, repo?: string) {
  return tauriInvoke<string>("git_commit", { message, repo: repo ?? null });
}

export async function tauri_gitPush(repo?: string) {
  const output = await tauriInvoke<string>("git_push", { remote: null, repo: repo ?? null });
  return { output, branch: "", setUpstream: false };
}

export async function tauri_gitFetch(repo?: string) {
  return tauriInvoke<string>("git_fetch", { repo: repo ?? null });
}

export async function tauri_gitCreateBranch(name: string, repo?: string) {
  await tauriInvoke("git_create_branch", { name, repo: repo ?? null });
  return "";
}

export async function tauri_gitSwitchBranch(name: string, repo?: string) {
  await tauriInvoke("git_switch_branch", { name, repo: repo ?? null });
}

export async function tauri_gitBranches(repo?: string) {
  const branches = await tauriInvoke<RustGitBranch[]>("git_branches", { repo: repo ?? null });
  return adaptBranches(branches);
}

export async function tauri_gitPullDefault(repo?: string) {
  const output = await tauriInvoke<string>("git_pull_default", { repo: repo ?? null });
  return { output, branch: "" };
}

export async function tauri_gitListFiles(repo?: string) {
  return tauriInvoke<string[]>("git_list_files", { repo: repo ?? null });
}

export async function tauri_gitReadFile(path: string, repo?: string) {
  const content = await tauriInvoke<string>("git_read_file", { path, repo: repo ?? null });
  return { content, truncated: false, binary: false, size: content.length };
}

export async function tauri_gitWriteFile(path: string, content: string, repo?: string) {
  await tauriInvoke("git_write_file", { path, content, repo: repo ?? null });
}

export async function tauri_deleteGitRepository(name: string) {
  await tauriInvoke("remove_git_repository", { name });
}

export async function tauri_registerGitRepository(repo: { name: string; path: string }) {
  return tauriInvoke("register_git_repository", { repo });
}

export async function tauri_setGitBoard(names: string[]) {
  await tauriInvoke("set_git_board_repositories", { names });
  return names;
}

// ---- GitHub ----

export async function tauri_getGithubTokenStatus() {
  return tauriInvoke<unknown>("get_github_token_status");
}

export async function tauri_listPullRequests(owner: string, repo: string, state?: string) {
  return tauriInvoke<unknown>("list_pull_requests", { owner, repo, stateFilter: state ?? "open" });
}

export async function tauri_listIssues(owner: string, repo: string, state?: string) {
  return tauriInvoke<unknown>("list_issues", { owner, repo, stateFilter: state ?? "open" });
}

// ---- Database ----

export async function tauri_listDatabases() {
  return tauriInvoke<unknown[]>("list_databases");
}

export async function tauri_queryDatabase(name: string, sql: string, limit?: number) {
  return tauriInvoke<unknown>("query_database", { name, sql, limit: limit ?? null });
}

export async function tauri_executeDatabase(name: string, sql: string) {
  return tauriInvoke<number>("execute_database", { name, sql });
}

export async function tauri_listTables(name: string) {
  return tauriInvoke<string[]>("list_tables", { name });
}

// ---- Snapshots ----

export async function tauri_listSnapshots(repo?: string) {
  return tauriInvoke<unknown[]>("list_snapshots", { repo: repo ?? null });
}

export async function tauri_createSnapshot(label?: string, repo?: string) {
  return tauriInvoke<unknown>("create_snapshot", { label: label ?? null, repo: repo ?? null });
}

export async function tauri_restoreSnapshot(sha: string, repo?: string) {
  await tauriInvoke("restore_snapshot", { sha, repo: repo ?? null });
}

export async function tauri_deleteSnapshot(sha: string, repo?: string) {
  await tauriInvoke("delete_snapshot", { sha, repo: repo ?? null });
}

// ---- Workflows ----

export async function tauri_listWorkflows() {
  return tauriInvoke<unknown[]>("list_workflows");
}

export async function tauri_saveWorkflow(workflow: unknown) {
  return tauriInvoke<unknown[]>("save_workflow", { workflow });
}

export async function tauri_deleteWorkflow(id: string) {
  return tauriInvoke<unknown[]>("delete_workflow", { id });
}

// ---- Terminal ----

export async function tauri_listTerminalSessions() {
  return tauriInvoke<unknown[]>("list_terminal_sessions");
}

export async function tauri_createTerminalSession(opts?: { serviceName?: string; cwd?: string }) {
  return tauriInvoke<{ id: string; serviceName: string | null }>("create_terminal_session", {
    serviceName: opts?.serviceName ?? null,
    cwd: opts?.cwd ?? null,
  });
}

export async function tauri_writeTerminalInput(id: string, data: string) {
  await tauriInvoke("write_terminal_input", { id, data });
}

export async function tauri_resizeTerminal(id: string, cols: number, rows: number) {
  await tauriInvoke("resize_terminal", { id, cols, rows });
}

export async function tauri_closeTerminalSession(id: string) {
  await tauriInvoke("close_terminal_session", { id });
}

export async function tauri_onTerminalOutput(
  id: string,
  handler: (data: string) => void,
): Promise<() => void> {
  return tauriListen(`terminal-output-${id}`, (payload) => handler(payload as string));
}

export { isTauri };
