/**
 * Tauri IPC bridge — maps Rust command responses to the shapes the React
 * components already expect. Loaded lazily so the web version pays no cost.
 */

import { isTauri } from "@/lib/tauri";
import type {
  AgentTranscriptInfo,
  CreateAgentTerminalOptions,
  TerminalSessionInfo,
} from "./terminal-api.js";

// Lazy-loaded to avoid bundling tauri APIs in the web build.
type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type ListenFn = (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
let _invoke: InvokeFn | null = null;
let _listen: ListenFn | null = null;

async function getInvoke() {
  if (!_invoke) {
    const mod = await import("@tauri-apps/api/core");
    // Cast to the named type, not `typeof _invoke` — inside this guard the latter
    // is narrowed to `null`, so the cast would target `null` and fail tsc.
    _invoke = mod.invoke as unknown as InvokeFn;
  }
  return _invoke!;
}

async function getListen() {
  if (!_listen) {
    const mod = await import("@tauri-apps/api/event");
    _listen = mod.listen as unknown as ListenFn;
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
  state: "stopped" | "starting" | "running" | "stopping" | "Stopped" | "Starting" | "Running" | "Stopping";
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

interface RustServiceDefinition {
  name?: unknown;
}

function adaptServiceStatus(s: RustServiceStatus) {
  const state = s.state.toLowerCase();
  return {
    name: s.name,
    state: state === "stopping" ? "stopped" : state as "stopped" | "starting" | "running",
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
  for (const service of raw.config.services as RustServiceDefinition[]) {
    if (typeof service.name !== "string" || servicesRecord[service.name]) continue;
    servicesRecord[service.name] = {
      name: service.name,
      state: "stopped",
      pid: undefined,
      exitCode: null,
      url: undefined,
    };
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

// ---------------------------------------------------------------------------
// Git-graph lane layout
// ---------------------------------------------------------------------------
// Assigns lane numbers following the same topology git uses for --graph output.
// `openSlots[i]` is the hash of the commit that will next occupy lane i.

function computeLanes(commits: RustGitCommit[]): Array<{
  lane: number;
  laneCount: number;
  edges: Array<{ fromLane: number; toLane: number; parentHash: string; kind: string }>;
  throughLanes: number[];
}> {
  const openSlots: (string | null)[] = [];

  return commits.map((commit) => {
    // Find this commit's lane (claimed by a prior iteration's parent assignment).
    let lane = openSlots.indexOf(commit.hash);
    if (lane === -1) {
      lane = openSlots.indexOf(null);
      if (lane === -1) { lane = openSlots.length; openSlots.push(null); }
    }
    openSlots[lane] = null; // release slot

    const edges: Array<{ fromLane: number; toLane: number; parentHash: string; kind: string }> = [];

    for (let pi = 0; pi < commit.parents.length; pi++) {
      const parentHash = commit.parents[pi];
      const existingSlot = openSlots.indexOf(parentHash);

      if (existingSlot !== -1) {
        // Parent already claimed by another path — draw converging edge.
        const kind = existingSlot === lane ? "straight" : "merge";
        edges.push({ fromLane: lane, toLane: existingSlot, parentHash, kind });
        continue;
      }

      // Claim a slot for this parent.
      let parentSlot: number;
      if (pi === 0) {
        // First parent keeps this lane (straight line).
        parentSlot = lane;
        openSlots[lane] = parentHash;
        edges.push({ fromLane: lane, toLane: lane, parentHash, kind: "straight" });
      } else {
        // Additional parents branch off to a new lane.
        parentSlot = openSlots.indexOf(null);
        if (parentSlot === -1) { parentSlot = openSlots.length; openSlots.push(parentHash); }
        else { openSlots[parentSlot] = parentHash; }
        edges.push({ fromLane: lane, toLane: parentSlot, parentHash, kind: "branch" });
      }
    }

    // Lanes with active commits that pass through (or alongside) this row.
    const throughLanes = openSlots
      .map((h, i) => (h !== null && i !== lane ? i : -1))
      .filter((i) => i !== -1);

    const laneCount = openSlots.reduce(
      (max, h, i) => (h !== null ? Math.max(max, i + 1) : max),
      lane + 1,
    );

    return { lane, laneCount, edges, throughLanes };
  });
}

export function adaptGitGraph(commits: RustGitCommit[]) {
  const lanes = computeLanes(commits);
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
    lane: lanes[i].lane,
    laneCount: lanes[i].laneCount,
    edges: lanes[i].edges,
    throughLanes: lanes[i].throughLanes,
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

interface RustProcessTreeSummary {
  rootPid: number;
  processCount: number;
  cpuPercent: number;
  rssMb: number;
  processes: Array<{ pid: number; ppid: number; cpuPercent: number; rssMb: number; command: string }>;
}

export async function tauri_serviceProcesses(name: string) {
  return tauriInvoke<RustProcessTreeSummary | null>("service_processes", { name });
}

export async function tauri_getDashboard() {
  const raw = await tauriInvoke<RustDashboardData>("get_dashboard");
  const dash = adaptDashboard(raw);

  // The Rust backend has no full health engine, but the service-detail
  // "Processes" tab reads its rows from `health[name].processTree`. Fetch a
  // process tree for each running service and stitch a minimal health record
  // so the tab populates instead of reading "service not running".
  const running = raw.runtime.services.filter((s) => s.state.toLowerCase() === "running");
  const health: Record<string, unknown> = {};
  await Promise.all(
    running.map(async (s) => {
      const tree = await tauri_serviceProcesses(s.name).catch(() => null);
      if (!tree) return;
      health[s.name] = {
        service: s.name,
        status: "unknown",
        summary: "",
        checkedAt: new Date().toISOString(),
        checks: [],
        processTree: tree,
        ports: [],
        agentContext: "",
      };
    }),
  );
  dash.health = health as typeof dash.health;

  // The Rust `get_dashboard` payload carries config + service runtime only — it
  // has no git block. Fill it here from the selected repo via the bridged git
  // commands; otherwise the desktop git view is permanently stuck on its empty
  // state and never reacts to switching repositories.
  const repos = (raw.config.gitRepositories ?? []) as Array<{ name: string; path: string }>;
  const selectedName = raw.config.selectedGitRepository;
  const selected = selectedName ? repos.find((r) => r.name === selectedName) ?? null : null;
  if (!selected) return dash;

  const [status, branches] = await Promise.all([
    tauri_gitStatus().catch(() => null),
    tauri_gitBranches().catch(() => []),
  ]);
  return {
    ...dash,
    git: { cwd: selected.path, selectedRepository: selected, status, branches },
  };
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

export async function tauri_gitFileSizes(repo?: string) {
  return tauriInvoke<Array<{ path: string; lines: number; bytes: number; truncated: boolean }>>(
    "git_file_sizes", { repo: repo ?? null },
  );
}

export async function tauri_selectGitRepository(name: string) {
  await tauriInvoke("select_git_repository", { name });
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

export async function tauri_cloneGitRepository(url: string) {
  return tauriInvoke<{ name: string; path: string }>("clone_git_repository", { url });
}

export async function tauri_setGitBoard(names: string[]) {
  await tauriInvoke("set_git_board_repositories", { names });
  return names;
}

/** Multi-repo overview: calls git_status for each registered repo in parallel. */
export async function tauri_gitOverview() {
  const raw = await tauriInvoke<RustDashboardData>("get_dashboard");
  const repos = raw.config.gitRepositories as Array<{ name: string; path: string }>;
  const boardNames = raw.config.gitBoardRepositories;

  const settled = await Promise.allSettled(
    repos.map(async (r) => {
      const status = await tauriInvoke<RustGitStatus>("git_status", { repo: r.name });
      return { name: r.name, path: r.path, branch: status.branch,
               ahead: status.ahead, behind: status.behind, files: status.files };
    }),
  );

  const resultRepos = settled.map((result, i) =>
    result.status === "fulfilled"
      ? result.value
      : { name: repos[i].name, path: repos[i].path, branch: "", ahead: 0,
          behind: 0, files: [], error: String((result as PromiseRejectedResult).reason) },
  );

  return {
    repos: resultRepos,
    board: boardNames ?? repos.map((r) => r.name),
  };
}

// ---- GitHub ----

export async function tauri_getGithubTokenStatus() {
  return tauriInvoke<unknown>("get_github_token_status");
}

export async function tauri_setGithubToken(host: string, token: string) {
  await tauriInvoke("set_github_token", { host, token });
}

export async function tauri_removeGithubToken(host: string) {
  await tauriInvoke("remove_github_token", { host });
}

/** Returns [owner, repo] from the selected repository's origin remote. */
export async function tauri_getGithubRepo(repo?: string): Promise<[string, string]> {
  return tauriInvoke<[string, string]>("get_github_repo", { repo: repo ?? null });
}

export async function tauri_listPullRequests(owner: string, repo: string, state?: string) {
  return tauriInvoke<unknown>("list_pull_requests", { owner, repo, stateFilter: state ?? "open" });
}

export async function tauri_listIssues(owner: string, repo: string, state?: string) {
  return tauriInvoke<unknown>("list_issues", { owner, repo, stateFilter: state ?? "open" });
}

export async function tauri_getPullRequest(owner: string, repo: string, number: number) {
  return tauriInvoke<unknown>("get_pull_request", { owner, repo, number });
}

export async function tauri_createPullRequest(opts: {
  owner: string; repo: string; title: string; body: string;
  head: string; base: string; draft?: boolean;
}) {
  return tauriInvoke<unknown>("create_pull_request", opts);
}

export async function tauri_githubOAuthStart(clientId: string) {
  return tauriInvoke<unknown>("github_oauth_start", { clientId });
}

export async function tauri_githubOAuthPoll(clientId: string, deviceCode: string) {
  return tauriInvoke<unknown>("github_oauth_poll", { clientId, deviceCode });
}

export async function tauri_getPrDiff(owner: string, repo: string, number: number) {
  return tauriInvoke<string>("get_pr_diff", { owner, repo, number });
}

export async function tauri_listPrFiles(owner: string, repo: string, number: number) {
  return tauriInvoke<unknown>("list_pr_files", { owner, repo, number });
}

export async function tauri_listPrReviews(owner: string, repo: string, number: number) {
  return tauriInvoke<unknown>("list_pr_reviews", { owner, repo, number });
}

export async function tauri_listPrComments(owner: string, repo: string, number: number) {
  return tauriInvoke<unknown>("list_pr_comments", { owner, repo, number });
}

export async function tauri_mergePullRequest(
  owner: string, repo: string, number: number,
  opts: { method?: string; commitTitle?: string; commitMessage?: string } = {},
) {
  return tauriInvoke<unknown>("merge_pull_request", {
    owner, repo, number,
    method: opts.method ?? null,
    commitTitle: opts.commitTitle ?? null,
    commitMessage: opts.commitMessage ?? null,
  });
}

export async function tauri_getGithubIssue(owner: string, repo: string, number: number) {
  return tauriInvoke<unknown>("get_github_issue", { owner, repo, number });
}

export async function tauri_listIssueComments(owner: string, repo: string, number: number) {
  return tauriInvoke<unknown>("list_issue_comments", { owner, repo, number });
}

export async function tauri_addIssueComment(owner: string, repo: string, number: number, body: string) {
  return tauriInvoke<unknown>("add_issue_comment", { owner, repo, number, body });
}

export async function tauri_createGithubIssue(owner: string, repo: string, title: string, body?: string) {
  return tauriInvoke<unknown>("create_github_issue", { owner, repo, title, body: body ?? null });
}

export async function tauri_listGithubBranches(owner: string, repo: string) {
  return tauriInvoke<unknown>("list_github_branches", { owner, repo });
}

export async function tauri_getGithubRepoInfo(owner: string, repo: string) {
  return tauriInvoke<unknown>("get_github_repo_info", { owner, repo });
}

export async function tauri_listCommitCheckRuns(owner: string, repo: string, sha: string) {
  return tauriInvoke<unknown>("list_commit_check_runs", { owner, repo, sha });
}

export async function tauri_listWorkflowRuns(owner: string, repo: string, branch?: string, page?: number) {
  return tauriInvoke<unknown>("list_workflow_runs", {
    owner, repo, branch: branch ?? null, page: page ?? null,
  });
}

export async function tauri_listWorkflowRunJobs(owner: string, repo: string, runId: number) {
  return tauriInvoke<unknown>("list_workflow_run_jobs", { owner, repo, runId });
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

export async function tauri_registerDatabase(db: {
  // projectPath rides along for forward-compat; the Rust core ignores it today.
  name: string; engine: string; url: string; projectPath?: string;
}) {
  await tauriInvoke("register_database", { db });
}

export async function tauri_removeDatabase(name: string) {
  await tauriInvoke("remove_database", { name });
}

export async function tauri_setDatabaseWriteAccess(name: string, unlocked: boolean) {
  await tauriInvoke("set_database_write_access", { name, unlocked });
}

// ---- Log Sources ----

export async function tauri_listLogSources() {
  const config = await tauriInvoke<{ logSources: unknown[] }>("get_config");
  return config.logSources;
}

export async function tauri_registerLogSource(source: Record<string, unknown>) {
  await tauriInvoke("register_log_source", { source });
}

export async function tauri_removeLogSource(name: string) {
  await tauriInvoke("remove_log_source", { name });
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

export async function tauri_getSnapshotFiles(sha: string, repo?: string) {
  return tauriInvoke<unknown[]>("get_snapshot_files", { sha, repo: repo ?? null });
}

export async function tauri_getSnapshotDiff(sha: string, path?: string, repo?: string) {
  return tauriInvoke<string>("get_snapshot_diff", { sha, path: path ?? null, repo: repo ?? null });
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

// ---- Agent introspection ----

export async function tauri_getAgentInfo() {
  return tauriInvoke<unknown>("get_agent_info");
}

// ---- Agent Chat ----

export async function tauri_getAgentChatStatus() {
  return tauriInvoke<{
    configured: boolean;
    approvals: boolean;
    provider: unknown;
    providers: unknown[];
  }>("get_agent_chat_status");
}

export async function tauri_setChatProvider(provider: string) {
  return tauriInvoke<unknown>("set_chat_provider", { provider });
}

export async function tauri_startAgentChat(message: string, resumeSessionId?: string, provider?: string) {
  await tauriInvoke("start_agent_chat", {
    message,
    resumeSessionId: resumeSessionId ?? null,
    provider: provider ?? null,
  });
}

// ---- Onboard ----

export async function tauri_scanRepoUrl(url: string) {
  return tauriInvoke<unknown>("scan_repo_url", { url });
}

export async function tauri_runInstallCommand(cwd: string, command: string) {
  await tauriInvoke("run_install_command", { cwd, command });
}

// ---- Terminal ----

export async function tauri_listTerminalSessions() {
  const sessions = await tauriInvoke<
    Array<TerminalSessionInfo & { serviceName?: string | null }>
  >(
    "list_terminal_sessions",
  );
  return sessions.map((session) => ({
    ...session,
    serviceName: session.serviceName ?? undefined,
    label: session.label ?? session.serviceName ?? undefined,
  }));
}

export async function tauri_listAgentTranscripts() {
  return tauriInvoke<AgentTranscriptInfo[]>("list_agent_transcripts");
}

export async function tauri_createTerminalSession(opts?: {
  serviceName?: string;
  cwd?: string;
  agent?: CreateAgentTerminalOptions;
}) {
  const session = await tauriInvoke<TerminalSessionInfo & { serviceName?: string | null }>(
    "create_terminal_session",
    {
      serviceName: opts?.serviceName ?? null,
      cwd: opts?.cwd ?? null,
      agent: opts?.agent ?? null,
    },
  );
  return {
    ...session,
    serviceName: session.serviceName ?? undefined,
    label: session.label ?? session.serviceName ?? undefined,
  };
}

export async function tauri_renameTerminalSession(id: string, label: string) {
  const session = await tauriInvoke<TerminalSessionInfo & { serviceName?: string | null }>(
    "rename_terminal_session",
    { id, label },
  );
  return {
    ...session,
    serviceName: session.serviceName ?? undefined,
    label: session.label ?? session.serviceName ?? undefined,
  };
}

export async function tauri_writeTerminalInput(id: string, data: string) {
  await tauriInvoke("write_terminal_input", { id, data });
}

/** Flush buffered startup output and switch the PTY to live emission. */
export async function tauri_startTerminalStream(id: string) {
  await tauriInvoke("start_terminal_stream", { id });
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
