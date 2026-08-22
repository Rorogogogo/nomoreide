mod diagnostics;
mod git;
mod github;
mod onboard;
mod registration;

use nomoreide_core::config::ConfigStore;
use nomoreide_daemon_client::protocol::{ServiceRuntimeState, ServiceRuntimeStatus};
use nomoreide_daemon_client::{DaemonClient, DaemonClientError, RuntimePaths, DEFAULT_DAEMON_PORT};
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;

pub(crate) type ToolFuture<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

pub(crate) trait ToolExecutor: Send + Sync {
    fn execute<'a>(&'a self, name: &'a str, arguments: &'a Map<String, Value>) -> ToolFuture<'a>;
}

pub(crate) struct NativeToolExecutor {
    paths: RuntimePaths,
    port: u16,
    /// Service definitions are read here rather than asked of the daemon, the
    /// way the reference reads them: a definition is what the user registered,
    /// and the daemon re-reads the same file per operation anyway.
    config: ConfigStore,
}

impl Default for NativeToolExecutor {
    fn default() -> Self {
        Self {
            paths: RuntimePaths::default(),
            port: std::env::var("NOMOREIDE_DAEMON_PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .filter(|port| *port > 0)
                .unwrap_or(DEFAULT_DAEMON_PORT),
            config: ConfigStore::new(ConfigStore::default_path()),
        }
    }
}

impl ToolExecutor for NativeToolExecutor {
    fn execute<'a>(&'a self, name: &'a str, arguments: &'a Map<String, Value>) -> ToolFuture<'a> {
        Box::pin(async move {
            match NativeTool::parse(name, arguments)? {
                // Registration writes config and never touches the runtime, so
                // it is served without a daemon. Requiring one would make
                // registering a service depend on something the service does
                // not need in order to be registered.
                NativeTool::RegisterService => {
                    registration::register_service(&self.config, arguments).await
                }
                NativeTool::RegisterBundle => {
                    registration::register_bundle(&self.config, arguments).await
                }
                // Repository registration and selection write config too, so
                // they are served without a daemon for the same reason.
                NativeTool::GitRegisterRepository { name, path } => {
                    git::register_repository(&self.config, name, path).await
                }
                NativeTool::GitSelectRepository(name) => {
                    git::select_repository(&self.config, name).await
                }
                // The reads run git in a directory the caller names. The
                // daemon owns running services, not repositories, so it has
                // no part in answering these either.
                NativeTool::GitStatus(cwd) => git::status(cwd).await,
                NativeTool::GitBranches(cwd) => git::branches(cwd).await,
                NativeTool::GitDiff { cwd, path } => git::diff(cwd, path).await,
                NativeTool::GitStagedDiff { cwd, path } => git::staged_diff(cwd, path).await,
                NativeTool::GitLog { cwd, limit } => git::log(cwd, limit).await,
                NativeTool::GitWorktrees(cwd) => git::worktrees(cwd).await,
                NativeTool::GitCreateWorktree {
                    cwd,
                    branch,
                    create_branch,
                    base_ref,
                    project_name,
                } => git::create_worktree(cwd, branch, create_branch, base_ref, project_name).await,
                NativeTool::GitSelectWorktree { repository, path } => {
                    git::select_worktree(&self.config, repository, path).await
                }
                NativeTool::GitPruneWorktrees(cwd) => git::prune_worktrees(cwd).await,
                NativeTool::GitStage { cwd, paths } => git::stage(cwd, &paths).await,
                NativeTool::GitUnstage { cwd, paths } => git::unstage(cwd, &paths).await,
                NativeTool::GitCommit { cwd, message } => {
                    git::commit(&self.config, cwd, message).await
                }
                NativeTool::GitCreateBranch { cwd, name } => git::create_branch(cwd, name).await,
                NativeTool::GitSwitchBranch { cwd, name } => git::switch_branch(cwd, name).await,
                NativeTool::GitFetch(cwd) => git::fetch(cwd).await,
                NativeTool::GitPush { cwd, remote } => git::push(&self.config, cwd, remote).await,
                NativeTool::GitClone(url) => git::clone(&self.config, url).await,
                // Snapshots and onboarding touch only git and the filesystem,
                // so they need no daemon either.
                NativeTool::SnapshotsList(cwd) => onboard::snapshots_list(cwd).await,
                NativeTool::SnapshotCreate { cwd, label } => {
                    onboard::snapshot_create(cwd, label).await
                }
                NativeTool::OnboardRepo(url) => onboard::onboard_repo(url).await,
                NativeTool::GithubSetToken { token, host } => {
                    github::set_token(&self.config, token, host).await
                }
                NativeTool::GithubListPrs { cwd, state, page } => {
                    github::list_prs(&self.config, cwd, state, page).await
                }
                NativeTool::GithubGetPr { cwd, number } => {
                    github::get_pr(&self.config, cwd, number).await
                }
                NativeTool::GithubGetPrDiff { cwd, number } => {
                    github::get_pr_diff(&self.config, cwd, number).await
                }
                NativeTool::GithubCreatePr {
                    cwd,
                    title,
                    body,
                    head,
                    base,
                    draft,
                } => github::create_pr(&self.config, cwd, title, body, head, base, draft).await,
                NativeTool::GithubMergePr {
                    cwd,
                    number,
                    method,
                    commit_title,
                    commit_message,
                } => {
                    github::merge_pr(
                        &self.config,
                        cwd,
                        number,
                        method,
                        commit_title,
                        commit_message,
                    )
                    .await
                }
                NativeTool::GithubListIssues { cwd, state, page } => {
                    github::list_issues(&self.config, cwd, state, page).await
                }
                NativeTool::GithubGetIssue { cwd, number } => {
                    github::get_issue(&self.config, cwd, number).await
                }
                NativeTool::GithubListIssueComments { cwd, number } => {
                    github::list_issue_comments(&self.config, cwd, number).await
                }
                NativeTool::GithubAddIssueComment { cwd, number, body } => {
                    github::add_issue_comment(&self.config, cwd, number, body).await
                }
                NativeTool::GithubCreateIssue { cwd, title, body } => {
                    github::create_issue(&self.config, cwd, title, body).await
                }
                NativeTool::GithubGetCommitCi { cwd, sha } => {
                    github::get_commit_ci(&self.config, cwd, sha).await
                }
                NativeTool::GithubListWorkflowRuns { cwd, branch, page } => {
                    github::list_workflow_runs(&self.config, cwd, branch, page).await
                }
                runtime => self.serve_runtime(runtime).await,
            }
        })
    }
}

impl NativeToolExecutor {
    /// Everything the daemon owns. The daemon has to be reachable first,
    /// because none of these questions has an answer without it.
    async fn serve_runtime(&self, tool: NativeTool<'_>) -> Result<String, String> {
        let client = DaemonClient::discover(&self.paths, self.port, env!("CARGO_PKG_VERSION"))
            .await
            .map_err(|error| error.to_string())?;
        match tool {
            NativeTool::ListServices => {
                let discovery = client.list_services().await.map_err(daemon_message)?;
                render(&discovery)
            }
            NativeTool::StartService(service) => {
                let status = client
                    .start_service(service)
                    .await
                    .map_err(daemon_message)?;
                render(&ServiceStatusView::of(&status))
            }
            NativeTool::StopService(service) => {
                let status = client.stop_service(service).await.map_err(daemon_message)?;
                render(&ServiceStatusView::of(&status))
            }
            NativeTool::RestartService(service) => {
                let status = client
                    .restart_service(service)
                    .await
                    .map_err(daemon_message)?;
                render(&ServiceStatusView::of(&status))
            }
            NativeTool::ReadLogs { service, limit } => {
                let logs = client.logs(service, limit).await.map_err(daemon_message)?;
                render(&logs)
            }
            NativeTool::Timeline { service, limit } => {
                // The reference asks for the whole buffer and narrows it
                // here, so filtering by service still returns the newest
                // `limit` events *for that service* rather than whatever
                // survived a filter applied to an already-truncated read.
                let events = client
                    .timeline(TIMELINE_READ_SIZE)
                    .await
                    .map_err(daemon_message)?;
                let matched = events
                    .into_iter()
                    .filter(|event| {
                        // `is_none_or` would read better but postdates the
                        // workspace MSRV.
                        service.map_or(true, |service| event.service.as_deref() == Some(service))
                    })
                    .collect::<Vec<_>>();
                let start = matched.len().saturating_sub(limit);
                render(&matched[start..])
            }
            NativeTool::Status => {
                let statuses = client.status().await.map_err(daemon_message)?;
                render(&StatusView::of(&statuses))
            }
            NativeTool::StartBundle(bundle) => {
                let statuses = client.start_bundle(bundle).await.map_err(daemon_message)?;
                render(&status_views(&statuses))
            }
            NativeTool::StopBundle(bundle) => {
                let statuses = client.stop_bundle(bundle).await.map_err(daemon_message)?;
                render(&status_views(&statuses))
            }
            NativeTool::ServiceContext(service) => {
                let config = self
                    .config
                    .load()
                    .await
                    .map_err(|error| error.to_string())?;
                diagnostics::service_context(&client, &config, service).await
            }
            NativeTool::ServiceHealth(service) => {
                let config = self
                    .config
                    .load()
                    .await
                    .map_err(|error| error.to_string())?;
                diagnostics::service_health(&client, &config, service).await
            }
            // Every git tool, and registration, was served before the daemon
            // was ever asked for.
            NativeTool::RegisterService
            | NativeTool::RegisterBundle
            | NativeTool::GitRegisterRepository { .. }
            | NativeTool::GitSelectRepository(_)
            | NativeTool::GitStatus(_)
            | NativeTool::GitBranches(_)
            | NativeTool::GitDiff { .. }
            | NativeTool::GitStagedDiff { .. }
            | NativeTool::GitLog { .. }
            | NativeTool::GitWorktrees(_)
            | NativeTool::GitCreateWorktree { .. }
            | NativeTool::GitSelectWorktree { .. }
            | NativeTool::GitPruneWorktrees(_)
            | NativeTool::GitStage { .. }
            | NativeTool::GitUnstage { .. }
            | NativeTool::GitCommit { .. }
            | NativeTool::GitCreateBranch { .. }
            | NativeTool::GitSwitchBranch { .. }
            | NativeTool::GitFetch(_)
            | NativeTool::GitPush { .. }
            | NativeTool::GitClone(_)
            | NativeTool::SnapshotsList(_)
            | NativeTool::SnapshotCreate { .. }
            | NativeTool::OnboardRepo(_)
            | NativeTool::GithubSetToken { .. }
            | NativeTool::GithubListPrs { .. }
            | NativeTool::GithubGetPr { .. }
            | NativeTool::GithubGetPrDiff { .. }
            | NativeTool::GithubCreatePr { .. }
            | NativeTool::GithubMergePr { .. }
            | NativeTool::GithubListIssues { .. }
            | NativeTool::GithubGetIssue { .. }
            | NativeTool::GithubListIssueComments { .. }
            | NativeTool::GithubAddIssueComment { .. }
            | NativeTool::GithubCreateIssue { .. }
            | NativeTool::GithubGetCommitCi { .. }
            | NativeTool::GithubListWorkflowRuns { .. } => {
                unreachable!("config writes and git operations are served locally")
            }
        }
    }
}

/// A tool this runtime serves itself, with its arguments already read. The
/// protocol layer enforces each tool's argument contract before execution;
/// re-reading it here keeps this boundary self-contained.
enum NativeTool<'a> {
    ListServices,
    StartService(&'a str),
    StopService(&'a str),
    RestartService(&'a str),
    ReadLogs {
        service: &'a str,
        limit: u32,
    },
    Timeline {
        service: Option<&'a str>,
        limit: usize,
    },
    StartBundle(&'a str),
    StopBundle(&'a str),
    Status,
    ServiceContext(&'a str),
    /// Registration reads its own arguments: the definition it assembles has
    /// eleven possible fields and three readings, so naming them here would be
    /// a second copy of that contract.
    RegisterService,
    RegisterBundle,
    /// An absent service asks about every registered one, so `None` is a wider
    /// question rather than a missing answer.
    ServiceHealth(Option<&'a str>),
    GitRegisterRepository {
        name: &'a str,
        path: &'a str,
    },
    GitSelectRepository(&'a str),
    /// Every read below takes the directory to run in. `None` is the
    /// reference's default — this process's own directory — rather than a
    /// missing argument.
    GitStatus(Option<&'a str>),
    GitBranches(Option<&'a str>),
    GitDiff {
        cwd: Option<&'a str>,
        path: Option<&'a str>,
    },
    GitStagedDiff {
        cwd: Option<&'a str>,
        path: Option<&'a str>,
    },
    GitLog {
        cwd: Option<&'a str>,
        limit: u32,
    },
    GitWorktrees(Option<&'a str>),
    GitCreateWorktree {
        cwd: Option<&'a str>,
        branch: &'a str,
        create_branch: bool,
        base_ref: Option<&'a str>,
        project_name: Option<&'a str>,
    },
    /// Selecting names the repository rather than a directory: it is a config
    /// write about a registration, not a question about wherever the caller is.
    GitSelectWorktree {
        repository: &'a str,
        path: &'a str,
    },
    GitPruneWorktrees(Option<&'a str>),
    /// Paths are owned rather than borrowed: they arrive as JSON values and
    /// have to be strings by the time git sees them.
    GitStage {
        cwd: Option<&'a str>,
        paths: Vec<String>,
    },
    GitUnstage {
        cwd: Option<&'a str>,
        paths: Vec<String>,
    },
    GitCommit {
        cwd: Option<&'a str>,
        message: &'a str,
    },
    GitCreateBranch {
        cwd: Option<&'a str>,
        name: &'a str,
    },
    GitSwitchBranch {
        cwd: Option<&'a str>,
        name: &'a str,
    },
    GitFetch(Option<&'a str>),
    GitPush {
        cwd: Option<&'a str>,
        remote: Option<&'a str>,
    },
    GitClone(&'a str),
    SnapshotsList(Option<&'a str>),
    SnapshotCreate {
        cwd: Option<&'a str>,
        label: &'a str,
    },
    OnboardRepo(&'a str),
    GithubSetToken {
        token: &'a str,
        host: &'a str,
    },
    GithubListPrs {
        cwd: Option<&'a str>,
        state: &'a str,
        page: u64,
    },
    GithubGetPr {
        cwd: Option<&'a str>,
        number: i64,
    },
    GithubGetPrDiff {
        cwd: Option<&'a str>,
        number: i64,
    },
    GithubCreatePr {
        cwd: Option<&'a str>,
        title: &'a str,
        body: Option<&'a str>,
        head: &'a str,
        base: &'a str,
        draft: bool,
    },
    GithubMergePr {
        cwd: Option<&'a str>,
        number: i64,
        method: &'a str,
        commit_title: Option<&'a str>,
        commit_message: Option<&'a str>,
    },
    GithubListIssues {
        cwd: Option<&'a str>,
        state: &'a str,
        page: u64,
    },
    GithubGetIssue {
        cwd: Option<&'a str>,
        number: i64,
    },
    GithubListIssueComments {
        cwd: Option<&'a str>,
        number: i64,
    },
    GithubAddIssueComment {
        cwd: Option<&'a str>,
        number: i64,
        body: &'a str,
    },
    GithubCreateIssue {
        cwd: Option<&'a str>,
        title: &'a str,
        body: Option<&'a str>,
    },
    GithubGetCommitCi {
        cwd: Option<&'a str>,
        sha: &'a str,
    },
    GithubListWorkflowRuns {
        cwd: Option<&'a str>,
        branch: Option<&'a str>,
        page: u64,
    },
}

impl<'a> NativeTool<'a> {
    fn parse(name: &str, arguments: &'a Map<String, Value>) -> Result<Self, String> {
        match name {
            "nomoreide_list_services" => Ok(Self::ListServices),
            "nomoreide_status" => Ok(Self::Status),
            "nomoreide_start_service" => Ok(Self::StartService(service_name(arguments)?)),
            "nomoreide_stop_service" => Ok(Self::StopService(service_name(arguments)?)),
            "nomoreide_restart_service" => Ok(Self::RestartService(service_name(arguments)?)),
            "nomoreide_read_logs" => Ok(Self::ReadLogs {
                service: service_name(arguments)?,
                limit: log_limit(arguments),
            }),
            "nomoreide_timeline" => Ok(Self::Timeline {
                service: arguments.get("service").and_then(Value::as_str),
                limit: arguments
                    .get("limit")
                    .and_then(Value::as_u64)
                    .and_then(|limit| usize::try_from(limit).ok())
                    .unwrap_or(DEFAULT_TIMELINE_LIMIT),
            }),
            "nomoreide_start_bundle" => Ok(Self::StartBundle(bundle_name(arguments)?)),
            "nomoreide_stop_bundle" => Ok(Self::StopBundle(bundle_name(arguments)?)),
            "nomoreide_service_context" => Ok(Self::ServiceContext(service_name(arguments)?)),
            "nomoreide_register_service" => Ok(Self::RegisterService),
            "nomoreide_register_bundle" => Ok(Self::RegisterBundle),
            "nomoreide_service_health" => Ok(Self::ServiceHealth(
                arguments.get("service").and_then(Value::as_str),
            )),
            "nomoreide_git_register_repository" => Ok(Self::GitRegisterRepository {
                name: required_name(arguments, "repository")?,
                path: required_text(arguments, "path")?,
            }),
            "nomoreide_git_select_repository" => Ok(Self::GitSelectRepository(required_name(
                arguments,
                "repository",
            )?)),
            "nomoreide_git_status" => Ok(Self::GitStatus(optional_text(arguments, "cwd"))),
            "nomoreide_git_branches" => Ok(Self::GitBranches(optional_text(arguments, "cwd"))),
            "nomoreide_git_diff" => Ok(Self::GitDiff {
                cwd: optional_text(arguments, "cwd"),
                path: optional_text(arguments, "path"),
            }),
            "nomoreide_git_staged_diff" => Ok(Self::GitStagedDiff {
                cwd: optional_text(arguments, "cwd"),
                path: optional_text(arguments, "path"),
            }),
            "nomoreide_git_log" => Ok(Self::GitLog {
                cwd: optional_text(arguments, "cwd"),
                limit: log_commit_limit(arguments),
            }),
            "nomoreide_git_worktrees" => Ok(Self::GitWorktrees(optional_text(arguments, "cwd"))),
            "nomoreide_git_create_worktree" => Ok(Self::GitCreateWorktree {
                cwd: optional_text(arguments, "cwd"),
                branch: required_text(arguments, "branch")?,
                // The reference's schema defaults this to true, so an absent
                // one asks for a new branch rather than an existing one.
                create_branch: arguments
                    .get("createBranch")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                base_ref: optional_text(arguments, "baseRef"),
                project_name: optional_text(arguments, "projectName"),
            }),
            "nomoreide_git_select_worktree" => Ok(Self::GitSelectWorktree {
                repository: required_text(arguments, "repository")?,
                path: required_text(arguments, "path")?,
            }),
            "nomoreide_git_prune_worktrees" => {
                Ok(Self::GitPruneWorktrees(optional_text(arguments, "cwd")))
            }
            "nomoreide_git_stage" => Ok(Self::GitStage {
                cwd: optional_text(arguments, "cwd"),
                paths: string_list(arguments, "paths"),
            }),
            "nomoreide_git_unstage" => Ok(Self::GitUnstage {
                cwd: optional_text(arguments, "cwd"),
                paths: string_list(arguments, "paths"),
            }),
            "nomoreide_git_commit" => Ok(Self::GitCommit {
                cwd: optional_text(arguments, "cwd"),
                // Not `required_text`: a message of only spaces clears that
                // bar, and refusing it is `GitManager::commit`'s job so the
                // dashboard and the desktop app are refused the same way.
                message: arguments
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            }),
            "nomoreide_git_create_branch" => Ok(Self::GitCreateBranch {
                cwd: optional_text(arguments, "cwd"),
                name: required_name(arguments, "branch")?,
            }),
            "nomoreide_git_switch_branch" => Ok(Self::GitSwitchBranch {
                cwd: optional_text(arguments, "cwd"),
                name: required_name(arguments, "branch")?,
            }),
            "nomoreide_git_fetch" => Ok(Self::GitFetch(optional_text(arguments, "cwd"))),
            "nomoreide_git_push" => Ok(Self::GitPush {
                cwd: optional_text(arguments, "cwd"),
                remote: optional_text(arguments, "remote"),
            }),
            "nomoreide_git_clone" => Ok(Self::GitClone(required_text(arguments, "url")?)),
            "nomoreide_snapshots_list" => Ok(Self::SnapshotsList(optional_text(arguments, "cwd"))),
            "nomoreide_snapshot_create" => Ok(Self::SnapshotCreate {
                cwd: optional_text(arguments, "cwd"),
                label: required_text(arguments, "label")?,
            }),
            "nomoreide_onboard_repo" => Ok(Self::OnboardRepo(required_text(arguments, "url")?)),
            "nomoreide_github_set_token" => Ok(Self::GithubSetToken {
                token: required_text(arguments, "token")?,
                // The reference's schema defaults this, so an absent host is
                // github.com rather than a missing argument.
                host: optional_text(arguments, "host").unwrap_or(DEFAULT_GITHUB_HOST),
            }),
            "nomoreide_github_list_prs" => Ok(Self::GithubListPrs {
                cwd: optional_text(arguments, "cwd"),
                state: enum_or(arguments, "state", DEFAULT_ISSUE_STATE),
                page: page(arguments),
            }),
            "nomoreide_github_get_pr" => Ok(Self::GithubGetPr {
                cwd: optional_text(arguments, "cwd"),
                number: number(arguments, "number"),
            }),
            "nomoreide_github_get_pr_diff" => Ok(Self::GithubGetPrDiff {
                cwd: optional_text(arguments, "cwd"),
                number: number(arguments, "number"),
            }),
            "nomoreide_github_create_pr" => Ok(Self::GithubCreatePr {
                cwd: optional_text(arguments, "cwd"),
                title: required_text(arguments, "title")?,
                // Absent stays absent all the way to GitHub: an empty body and
                // no body are different things to a pull request.
                body: optional_text(arguments, "body"),
                head: required_text(arguments, "head")?,
                base: required_text(arguments, "base")?,
                draft: arguments
                    .get("draft")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }),
            "nomoreide_github_merge_pr" => Ok(Self::GithubMergePr {
                cwd: optional_text(arguments, "cwd"),
                number: number(arguments, "number"),
                method: enum_or(arguments, "method", DEFAULT_MERGE_METHOD),
                commit_title: optional_text(arguments, "commitTitle"),
                commit_message: optional_text(arguments, "commitMessage"),
            }),
            "nomoreide_github_list_issues" => Ok(Self::GithubListIssues {
                cwd: optional_text(arguments, "cwd"),
                state: enum_or(arguments, "state", DEFAULT_ISSUE_STATE),
                page: page(arguments),
            }),
            "nomoreide_github_get_issue" => Ok(Self::GithubGetIssue {
                cwd: optional_text(arguments, "cwd"),
                number: number(arguments, "number"),
            }),
            "nomoreide_github_list_issue_comments" => Ok(Self::GithubListIssueComments {
                cwd: optional_text(arguments, "cwd"),
                number: number(arguments, "number"),
            }),
            "nomoreide_github_add_issue_comment" => Ok(Self::GithubAddIssueComment {
                cwd: optional_text(arguments, "cwd"),
                number: number(arguments, "number"),
                body: required_text(arguments, "body")?,
            }),
            "nomoreide_github_create_issue" => Ok(Self::GithubCreateIssue {
                cwd: optional_text(arguments, "cwd"),
                title: required_text(arguments, "title")?,
                body: optional_text(arguments, "body"),
            }),
            "nomoreide_github_get_commit_ci" => Ok(Self::GithubGetCommitCi {
                cwd: optional_text(arguments, "cwd"),
                sha: required_text(arguments, "sha")?,
            }),
            "nomoreide_github_list_workflow_runs" => Ok(Self::GithubListWorkflowRuns {
                cwd: optional_text(arguments, "cwd"),
                branch: optional_text(arguments, "branch"),
                page: page(arguments),
            }),
            _ => Err(format!("Tool '{name}' is not implemented.")),
        }
    }
}

/// The reference's `z.string().min(1).default("github.com")`.
const DEFAULT_GITHUB_HOST: &str = "github.com";
/// The reference's `z.enum(["open", "closed", "all"]).default("open")`.
const DEFAULT_ISSUE_STATE: &str = "open";
/// The reference's `z.enum(["merge", "squash", "rebase"]).default("squash")`.
const DEFAULT_MERGE_METHOD: &str = "squash";
/// The reference's `z.number().int().positive().default(1)`.
const DEFAULT_PAGE: u64 = 1;

/// A defaulted enum. The protocol layer has already rejected any value that is
/// not one of the choices, so an absent one is the only thing left to fill in.
fn enum_or<'a>(arguments: &'a Map<String, Value>, key: &str, fallback: &'a str) -> &'a str {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
}

fn page(arguments: &Map<String, Value>) -> u64 {
    arguments
        .get("page")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_PAGE)
}

/// A required positive integer the protocol layer has already checked, so
/// anything unreadable here could not have reached this point.
fn number(arguments: &Map<String, Value>, key: &str) -> i64 {
    arguments
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or_default()
}

fn service_name(arguments: &Map<String, Value>) -> Result<&str, String> {
    required_name(arguments, "service")
}

fn bundle_name(arguments: &Map<String, Value>) -> Result<&str, String> {
    required_name(arguments, "bundle")
}

/// The reference asks the daemon for 500 lines when the caller names no limit.
/// The protocol layer has already rejected anything outside `(0, 1000]`, so a
/// value that reaches here is in range.
const DEFAULT_LOG_LIMIT: u32 = 500;

fn log_limit(arguments: &Map<String, Value>) -> u32 {
    arguments
        .get("limit")
        .and_then(Value::as_u64)
        .and_then(|limit| u32::try_from(limit).ok())
        .unwrap_or(DEFAULT_LOG_LIMIT)
}

/// The reference reads 200 events and narrows them, and reports at most 80 when
/// the caller names no limit. The protocol layer has already rejected anything
/// outside `(0, 200]`.
const TIMELINE_READ_SIZE: u32 = 200;
const DEFAULT_TIMELINE_LIMIT: usize = 80;

/// The `name` argument. `kind` is the noun for the refusal — *not* the key
/// read, which is always `name`.
fn required_name<'a>(arguments: &'a Map<String, Value>, kind: &str) -> Result<&'a str, String> {
    arguments
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("Registered {kind} name is required."))
}

/// An array of strings under `key`. The protocol layer has already rejected a
/// missing array, a non-array, and a non-string member, so anything dropped
/// here could not have reached git as a path anyway.
fn string_list(arguments: &Map<String, Value>, key: &str) -> Vec<String> {
    arguments
        .get(key)
        .and_then(Value::as_array)
        .map(|members| {
            members
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// A required non-empty argument under `key`. Like [`required_name`], this
/// cannot fail in practice — the tool's `ArgumentContract` has already rejected
/// a missing or empty value — so the wording is only a fallback.
fn required_text<'a>(arguments: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("A {key} is required."))
}

/// An argument the caller may leave out. The protocol layer has already
/// rejected a present-but-empty string, so anything that reaches here and is
/// absent was genuinely not named.
fn optional_text<'a>(arguments: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    arguments.get(key).and_then(Value::as_str)
}

/// `nomoreide_git_log` reads ten commits when the caller names no limit. The
/// protocol layer has already rejected anything outside `(0, 50]`.
const DEFAULT_COMMIT_LIMIT: u32 = 10;

fn log_commit_limit(arguments: &Map<String, Value>) -> u32 {
    arguments
        .get("limit")
        .and_then(Value::as_u64)
        .and_then(|limit| u32::try_from(limit).ok())
        .unwrap_or(DEFAULT_COMMIT_LIMIT)
}

/// The reference reports runtime status as an object keyed by service name.
/// The daemon sorts the services, and a `BTreeMap` keeps that order here, so
/// two consecutive reads are comparable.
#[derive(Serialize)]
struct StatusView<'a> {
    services: BTreeMap<&'a str, ServiceStatusView<'a>>,
}

impl<'a> StatusView<'a> {
    fn of(statuses: &'a [ServiceRuntimeStatus]) -> Self {
        Self {
            services: statuses
                .iter()
                .map(|status| (status.name.as_str(), ServiceStatusView::of(status)))
                .collect(),
        }
    }
}

/// The reference returns a bundle's statuses as a plain array, in the order the
/// services were acted on.
fn status_views(statuses: &[ServiceRuntimeStatus]) -> Vec<ServiceStatusView<'_>> {
    statuses.iter().map(ServiceStatusView::of).collect()
}

pub(crate) fn render<T: Serialize + ?Sized>(value: &T) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|error| error.to_string())
}

/// Agents read the daemon's own explanation — "Service is not registered.", a
/// port conflict, a draining daemon — rather than this client's transport
/// wrapper around it.
fn daemon_message(error: DaemonClientError) -> String {
    match error {
        DaemonClientError::Mutation(failure) => failure.message,
        other => other.to_string(),
    }
}

/// How a runtime state reads to an agent. The reference has no distinct
/// stopping state, so a service on its way down reports as stopped.
fn state_label(state: ServiceRuntimeState) -> &'static str {
    match state {
        ServiceRuntimeState::Stopped | ServiceRuntimeState::Stopping => "stopped",
        ServiceRuntimeState::Starting => "starting",
        ServiceRuntimeState::Running => "running",
        ServiceRuntimeState::Exited => "exited",
    }
}

/// The status shape the reference implementation returns for these tools:
/// these keys, in this order, with absent ones skipped. The process-group id
/// the daemon tracks is an ownership detail agents have no use for, so it
/// stays inside the daemon boundary.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatusView<'a> {
    name: &'a str,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'a str>,
    /// Only a remote service has one, so this is the one field of the shape
    /// that is absent for the common case rather than present and empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<&'a str>,
    /// A container id stands where a pid stands for every other kind, but the
    /// reference reports it here, after the launch time, rather than in the
    /// pid's place.
    #[serde(skip_serializing_if = "Option::is_none")]
    container_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exited_at: Option<&'a str>,
    /// Once a process has terminated the reference reports the pair, with
    /// whichever half does not apply explicitly `null` — a process killed by a
    /// signal has no exit code, and reporting only the code would say nothing
    /// about the most interesting way for a service to die. Hence the nesting:
    /// the outer `None` skips the key, `Some(None)` writes `null`.
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<Option<i32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal: Option<Option<&'a str>>,
}

impl<'a> ServiceStatusView<'a> {
    fn of(status: &'a ServiceRuntimeStatus) -> Self {
        // `exitedAt` is the one field the runtime stamps for every ending,
        // whatever it was, so it — not the exit code — decides whether this
        // run has an ending to report at all. A container's end is not a
        // process's end, though: it has no exit code and was killed by no
        // signal, so it reports neither rather than reporting both as null.
        let ended = status.exited_at.is_some() && status.container_id.is_none();
        Self {
            name: &status.name,
            state: state_label(status.state),
            kind: status.kind.as_deref(),
            host: status.host.as_deref(),
            pid: status.pid,
            started_at: status.started_at.as_deref(),
            container_id: status.container_id.as_deref(),
            url: status.url.as_deref(),
            exited_at: status.exited_at.as_deref(),
            exit_code: ended.then_some(status.exit_code),
            signal: ended.then_some(status.signal.as_deref()),
        }
    }
}

#[cfg(test)]
pub(crate) struct StaticToolExecutor {
    pub result: Result<String, String>,
}

#[cfg(test)]
impl ToolExecutor for StaticToolExecutor {
    fn execute<'a>(&'a self, _name: &'a str, _arguments: &'a Map<String, Value>) -> ToolFuture<'a> {
        Box::pin(async move { self.result.clone() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nomoreide_daemon_client::protocol::DaemonErrorCode;
    use nomoreide_daemon_client::{DaemonApiError, StatusCode};

    fn status(state: ServiceRuntimeState) -> ServiceRuntimeStatus {
        ServiceRuntimeStatus {
            name: "api".into(),
            state,
            kind: Some("local".into()),
            host: None,
            container_id: None,
            pid: Some(4321),
            pgid: Some(4321),
            exit_code: None,
            url: Some("http://localhost:3000".into()),
            started_at: Some("2026-08-21T10:00:00.000Z".into()),
            exited_at: None,
            signal: None,
        }
    }

    #[test]
    fn status_text_matches_the_reference_field_set_and_order() {
        let rendered = render(&ServiceStatusView::of(&status(
            ServiceRuntimeState::Running,
        )))
        .unwrap();
        assert_eq!(
            rendered,
            concat!(
                "{\n",
                "  \"name\": \"api\",\n",
                "  \"state\": \"running\",\n",
                "  \"kind\": \"local\",\n",
                "  \"pid\": 4321,\n",
                "  \"startedAt\": \"2026-08-21T10:00:00.000Z\",\n",
                "  \"url\": \"http://localhost:3000\"\n",
                "}"
            )
        );
        assert!(!rendered.contains("pgid"));
        // Still running, so there is no ending to report.
        assert!(!rendered.contains("exitCode"));
        assert!(!rendered.contains("signal"));
    }

    #[test]
    fn an_ended_run_reports_the_exit_code_and_signal_as_a_pair() {
        let exited = ServiceRuntimeStatus {
            pid: None,
            url: None,
            exit_code: Some(3),
            exited_at: Some("2026-08-21T10:05:00.000Z".into()),
            ..status(ServiceRuntimeState::Exited)
        };
        assert_eq!(
            render(&ServiceStatusView::of(&exited)).unwrap(),
            concat!(
                "{\n",
                "  \"name\": \"api\",\n",
                "  \"state\": \"exited\",\n",
                "  \"kind\": \"local\",\n",
                "  \"startedAt\": \"2026-08-21T10:00:00.000Z\",\n",
                "  \"exitedAt\": \"2026-08-21T10:05:00.000Z\",\n",
                "  \"exitCode\": 3,\n",
                "  \"signal\": null\n",
                "}"
            )
        );

        // Killed by a signal instead: the same pair, the other half filled in.
        let signalled = ServiceRuntimeStatus {
            exit_code: None,
            signal: Some("SIGTERM".into()),
            ..exited
        };
        let rendered = render(&ServiceStatusView::of(&signalled)).unwrap();
        assert!(rendered.contains("\"exitCode\": null"), "{rendered}");
        assert!(rendered.contains("\"signal\": \"SIGTERM\""), "{rendered}");
    }

    #[test]
    fn status_is_keyed_by_service_name_and_hides_the_process_group() {
        let statuses = vec![
            ServiceRuntimeStatus {
                name: "web".into(),
                ..status(ServiceRuntimeState::Running)
            },
            ServiceRuntimeStatus {
                name: "api".into(),
                ..status(ServiceRuntimeState::Running)
            },
        ];
        let rendered = render(&StatusView::of(&statuses)).unwrap();
        let parsed: Value = serde_json::from_str(&rendered).unwrap();
        assert_eq!(parsed["services"]["api"]["state"], "running");
        assert_eq!(parsed["services"]["web"]["pid"], 4321);
        assert!(!rendered.contains("pgid"));
        // Sorted, so two consecutive reads of the same runtime compare equal.
        assert!(rendered.find("\"api\"").unwrap() < rendered.find("\"web\"").unwrap());
    }

    #[test]
    fn a_container_reports_no_exit_code_because_it_ended_no_process() {
        let running = ServiceRuntimeStatus {
            kind: Some("docker-compose".into()),
            container_id: Some("container-abc".into()),
            pid: None,
            pgid: None,
            url: None,
            ..status(ServiceRuntimeState::Running)
        };
        assert_eq!(
            render(&ServiceStatusView::of(&running)).unwrap(),
            concat!(
                "{\n",
                "  \"name\": \"api\",\n",
                "  \"state\": \"running\",\n",
                "  \"kind\": \"docker-compose\",\n",
                "  \"startedAt\": \"2026-08-21T10:00:00.000Z\",\n",
                "  \"containerId\": \"container-abc\"\n",
                "}"
            )
        );

        // Taken down, the container keeps its identity and gains an ending —
        // but not the exit code and signal a process would report, which is
        // what the reference does too.
        let stopped = ServiceRuntimeStatus {
            exited_at: Some("2026-08-21T10:05:00.000Z".into()),
            ..ServiceRuntimeStatus {
                state: ServiceRuntimeState::Stopped,
                ..running
            }
        };
        let rendered = render(&ServiceStatusView::of(&stopped)).unwrap();
        assert!(
            rendered.ends_with("\"exitedAt\": \"2026-08-21T10:05:00.000Z\"\n}"),
            "{rendered}"
        );
        assert!(!rendered.contains("exitCode"), "{rendered}");
        assert!(!rendered.contains("signal"), "{rendered}");
    }

    #[test]
    fn a_service_that_never_ran_reports_only_what_the_reference_reports() {
        let never_ran = ServiceRuntimeStatus {
            kind: None,
            pid: None,
            pgid: None,
            url: None,
            started_at: None,
            ..status(ServiceRuntimeState::Stopped)
        };
        assert_eq!(
            render(&ServiceStatusView::of(&never_ran)).unwrap(),
            "{\n  \"name\": \"api\",\n  \"state\": \"stopped\"\n}"
        );
        // The reference has no distinct stopping state to report.
        assert_eq!(
            ServiceStatusView::of(&status(ServiceRuntimeState::Stopping)).state,
            "stopped"
        );
    }

    #[test]
    fn mutations_need_a_service_name_and_report_the_daemon_explanation() {
        let mut arguments = Map::new();
        assert!(NativeTool::parse("nomoreide_start_service", &arguments).is_err());
        arguments.insert("name".into(), Value::String(String::new()));
        assert!(NativeTool::parse("nomoreide_stop_service", &arguments).is_err());
        assert!(NativeTool::parse("nomoreide_restart_service", &arguments).is_err());
        assert!(NativeTool::parse("nomoreide_start_bundle", &arguments).is_err());
        arguments.insert("name".into(), Value::String("api".into()));
        assert!(matches!(
            NativeTool::parse("nomoreide_stop_service", &arguments),
            Ok(NativeTool::StopService("api"))
        ));
        assert!(matches!(
            NativeTool::parse("nomoreide_restart_service", &arguments),
            Ok(NativeTool::RestartService("api"))
        ));
        assert!(matches!(
            NativeTool::parse("nomoreide_start_bundle", &arguments),
            Ok(NativeTool::StartBundle("api"))
        ));
        assert!(matches!(
            NativeTool::parse("nomoreide_stop_bundle", &arguments),
            Ok(NativeTool::StopBundle("api"))
        ));
        assert!(matches!(
            NativeTool::parse("nomoreide_status", &arguments),
            Ok(NativeTool::Status)
        ));
        assert!(matches!(
            NativeTool::parse("nomoreide_service_context", &arguments),
            Ok(NativeTool::ServiceContext("api"))
        ));
        // An absent service is the whole-runtime question, not a missing name.
        assert!(matches!(
            NativeTool::parse("nomoreide_service_health", &Map::new()),
            Ok(NativeTool::ServiceHealth(None))
        ));
        let mut health = Map::new();
        health.insert("service".into(), Value::String("api".into()));
        assert!(matches!(
            NativeTool::parse("nomoreide_service_health", &health),
            Ok(NativeTool::ServiceHealth(Some("api")))
        ));
        assert!(NativeTool::parse("nomoreide_service_context", &Map::new()).is_err());
        // Outside phase 2, so still refused by the executor.
        assert!(NativeTool::parse("nomoreide_list_errors", &arguments).is_err());

        assert_eq!(
            daemon_message(DaemonClientError::Mutation(Box::new(DaemonApiError {
                status: StatusCode::CONFLICT,
                code: DaemonErrorCode::PortInUse,
                message: "Port 3000 is already in use for api".into(),
                conflict: None,
            }))),
            "Port 3000 is already in use for api"
        );
    }

    /// Every git read takes the directory to work in, and every one of them
    /// treats an absent one as "wherever this process was started" rather than
    /// as a missing argument.
    #[test]
    fn a_git_read_without_a_cwd_is_a_question_about_here() {
        assert!(matches!(
            NativeTool::parse("nomoreide_git_status", &Map::new()),
            Ok(NativeTool::GitStatus(None))
        ));
        assert!(matches!(
            NativeTool::parse("nomoreide_git_branches", &Map::new()),
            Ok(NativeTool::GitBranches(None))
        ));
        assert!(matches!(
            NativeTool::parse("nomoreide_git_diff", &Map::new()),
            Ok(NativeTool::GitDiff {
                cwd: None,
                path: None
            })
        ));

        let mut arguments = Map::new();
        arguments.insert("cwd".into(), Value::String("/repo".into()));
        arguments.insert("path".into(), Value::String("src/main.rs".into()));
        assert!(matches!(
            NativeTool::parse("nomoreide_git_staged_diff", &arguments),
            Ok(NativeTool::GitStagedDiff {
                cwd: Some("/repo"),
                path: Some("src/main.rs")
            })
        ));
    }

    /// The reference reads ten commits when the caller names no limit.
    #[test]
    fn git_log_defaults_to_the_reference_commit_budget() {
        assert!(matches!(
            NativeTool::parse("nomoreide_git_log", &Map::new()),
            Ok(NativeTool::GitLog {
                cwd: None,
                limit: 10
            })
        ));
        let mut arguments = Map::new();
        arguments.insert("limit".into(), Value::from(3));
        assert!(matches!(
            NativeTool::parse("nomoreide_git_log", &arguments),
            Ok(NativeTool::GitLog {
                cwd: None,
                limit: 3
            })
        ));
    }

    /// The reference's schema defaults `createBranch` to true, so an absent
    /// one asks for a new branch rather than an existing one.
    #[test]
    fn creating_a_worktree_defaults_to_creating_its_branch() {
        let mut arguments = Map::new();
        arguments.insert("branch".into(), Value::String("feature/x".into()));
        assert!(matches!(
            NativeTool::parse("nomoreide_git_create_worktree", &arguments),
            Ok(NativeTool::GitCreateWorktree {
                cwd: None,
                branch: "feature/x",
                create_branch: true,
                base_ref: None,
                project_name: None,
            })
        ));

        arguments.insert("createBranch".into(), Value::Bool(false));
        arguments.insert("baseRef".into(), Value::String("main".into()));
        arguments.insert("projectName".into(), Value::String("demo".into()));
        arguments.insert("cwd".into(), Value::String("/repo".into()));
        assert!(matches!(
            NativeTool::parse("nomoreide_git_create_worktree", &arguments),
            Ok(NativeTool::GitCreateWorktree {
                cwd: Some("/repo"),
                branch: "feature/x",
                create_branch: false,
                base_ref: Some("main"),
                project_name: Some("demo"),
            })
        ));
    }

    /// Selecting a worktree names the repository it belongs to, not a
    /// directory to run in — so neither argument has a default.
    #[test]
    fn selecting_a_worktree_names_a_repository_and_a_path() {
        assert!(NativeTool::parse("nomoreide_git_select_worktree", &Map::new()).is_err());
        let mut arguments = Map::new();
        arguments.insert("repository".into(), Value::String("demo".into()));
        assert!(NativeTool::parse("nomoreide_git_select_worktree", &arguments).is_err());
        arguments.insert("path".into(), Value::String("/repo/wt".into()));
        assert!(matches!(
            NativeTool::parse("nomoreide_git_select_worktree", &arguments),
            Ok(NativeTool::GitSelectWorktree {
                repository: "demo",
                path: "/repo/wt"
            })
        ));
    }

    /// The reference asks the daemon for 500 lines when the caller names none,
    /// and passes the caller's number through otherwise.
    #[test]
    fn read_logs_defaults_to_the_reference_line_budget() {
        let mut arguments = Map::new();
        arguments.insert("name".into(), Value::String("api".into()));
        assert!(matches!(
            NativeTool::parse("nomoreide_read_logs", &arguments),
            Ok(NativeTool::ReadLogs {
                service: "api",
                limit: 500
            })
        ));
        arguments.insert("limit".into(), Value::from(25));
        assert!(matches!(
            NativeTool::parse("nomoreide_read_logs", &arguments),
            Ok(NativeTool::ReadLogs {
                service: "api",
                limit: 25
            })
        ));
    }
}
