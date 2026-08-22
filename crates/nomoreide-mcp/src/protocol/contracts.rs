//! What each ported tool accepts, and how it refuses everything else.
//!
//! The reference implementation validates a tool's arguments with zod before
//! the tool runs, so the same request has to fail here in the same way — down
//! to the message an agent reads back. These contracts are therefore read from
//! the running reference rather than from its source: several of the wordings
//! below are not what the schema they mirror looks like it would produce.

use serde_json::{Map, Value};

/// The argument contract of a tool the native runtime serves itself. Unknown
/// keys are stripped rather than rejected, so only declared fields can fail.
pub(super) enum ArgumentContract {
    Empty,
    /// A single required non-empty `name`. The reference's `serviceNameSchema`
    /// and `bundleNameSchema` are the same shape, so they reject the same
    /// arguments with the same wording.
    RequiredName,
    /// `nomoreide_read_logs`: the same required `name` plus an optional
    /// `limit` in `(0, 1000]`. zod reports every field it rejected, in schema
    /// order, so this collects failures instead of returning the first.
    ServiceLogs,
    /// `nomoreide_timeline`: both fields optional — an absent `service` means
    /// every service rather than one named nothing.
    Timeline,
    /// `nomoreide_service_health`: one optional non-empty `service`. Absent
    /// asks about every registered service; present and empty is still a
    /// rejected name.
    OptionalService,
    /// `nomoreide_register_service`: eleven fields, every one but `name`
    /// optional. This is only the first of two gates — it decides whether the
    /// arguments are well-formed, and the executor then decides whether they
    /// describe a service of some kind. A field that clears this one can never
    /// fail the second on its type or its length, only by being missing.
    ServiceRegistration,
    /// `nomoreide_register_bundle`: a name and at least one non-empty member.
    /// Its second gate is strictly weaker than this one, so a bundle that
    /// reaches the executor always registers.
    BundleRegistration,
    /// `nomoreide_git_register_repository`: a name and a path, both required
    /// and non-empty. Whether the path is absolute and actually a worktree is
    /// the executor's question, not this one's — the reference asks it in
    /// `ConfigStore`, after zod has passed.
    RepositoryRegistration,
    /// `nomoreide_git_status` and `nomoreide_git_branches`: one optional
    /// non-empty `cwd`. Absent means the directory the server was started in,
    /// so it is a default rather than a missing argument.
    GitCwd,
    /// `nomoreide_git_diff` and `nomoreide_git_staged_diff`: that `cwd` plus an
    /// optional non-empty `path` to narrow the patch to.
    GitPath,
    /// `nomoreide_git_log`: that `cwd` plus an optional `limit` in `(0, 50]` —
    /// a tighter bound than the log-line limit, because these are commits.
    GitLog,
    /// `nomoreide_git_create_worktree`: the `cwd` base, a required `branch`,
    /// and three optional narrowings. `createBranch` defaults to true, so an
    /// absent one is a valid request rather than a missing argument.
    WorktreeCreation,
    /// `nomoreide_git_select_worktree`: a registered repository name and a
    /// path, both required. Whether the path is one of that repository's
    /// worktrees is the store's question, not this one's.
    WorktreeSelection,
    /// `nomoreide_git_switch_branch` and `nomoreide_git_create_branch`: the
    /// `cwd` base plus a required `name`. Whether the name is one git would
    /// accept is decided later, by git.
    GitBranchName,
    /// `nomoreide_git_stage` and `nomoreide_git_unstage`: the `cwd` base plus
    /// at least one non-empty path. A path of only spaces clears this bar and
    /// is refused by the operation itself.
    GitPaths,
    /// `nomoreide_git_commit`: the `cwd` base plus a required `message`. A
    /// blank one likewise gets past here.
    GitCommit,
    /// `nomoreide_git_push`: the `cwd` base plus an optional non-empty
    /// `remote`. Absent means `origin`, which is a default rather than a
    /// missing argument.
    GitPush,
    /// `nomoreide_git_clone`: one required non-empty `url`. Whether it is a URL
    /// of a shape git could clone is decided by the clone itself, which names
    /// the part that was wrong.
    RepositoryClone,
    /// `nomoreide_github_set_token`: a required `token` and a `host` that
    /// defaults to github.com — so an absent host is valid and an empty one is
    /// still too short.
    GithubToken,
    /// `nomoreide_github_list_prs` and `_list_issues`: the `cwd` base, a state
    /// out of three, and a page. Both are defaulted, so absent is valid.
    GithubListing,
    /// `nomoreide_github_get_pr`, `_get_pr_diff`, `_get_issue`, and
    /// `_list_issue_comments`: the `cwd` base plus a required positive number.
    GithubNumber,
    /// `nomoreide_github_create_pr`: a title, a head, and a base, with an
    /// optional body and a defaulted `draft`. The body may be empty — a pull
    /// request with no description is a real thing to open.
    GithubPrCreation,
    /// `nomoreide_github_merge_pr`: the number, a defaulted method, and two
    /// optional commit overrides.
    GithubPrMerge,
    /// `nomoreide_github_add_issue_comment`: the number plus a non-empty body.
    /// A comment saying nothing is not one.
    GithubComment,
    /// `nomoreide_github_create_issue`: a required title and an optional body.
    GithubIssueCreation,
    /// `nomoreide_github_get_commit_ci`: a SHA long enough for git to resolve —
    /// seven characters, the abbreviation git itself prints.
    GithubCommitSha,
    /// `nomoreide_github_list_workflow_runs`: the `cwd` base, an optional
    /// branch filter, and a page.
    GithubWorkflowRuns,
}

/// The reference's `z.number().int().positive().max(1000)`.
const LOG_LIMIT_MAX: f64 = 1000.0;
/// The reference's `z.number().int().positive().max(50)`.
const COMMIT_LIMIT_MAX: f64 = 50.0;
/// The reference's `z.number().int().positive().max(200).default(80)`.
const TIMELINE_LIMIT_MAX: f64 = 200.0;
/// The reference's `z.number().int().positive().max(65535)`.
const PORT_MAX: f64 = 65535.0;
/// The reference's `z.enum(["open", "closed", "all"])`.
const ISSUE_STATES: &[&str] = &["open", "closed", "all"];
/// The reference's `z.enum(["merge", "squash", "rebase"])`.
const MERGE_METHODS: &[&str] = &["merge", "squash", "rebase"];
/// The reference's `z.string().min(7)` — the abbreviation git itself prints.
const SHA_MIN_LENGTH: usize = 7;
/// A page number is `z.number().int().positive()` with no ceiling of its own,
/// so this only has to be something no real page reaches.
const PAGE_MAX: f64 = f64::MAX;
/// The kinds of service the reference knows how to run.
const SERVICE_KINDS: &[&str] = &["local", "docker-compose", "ssh"];

impl ArgumentContract {
    pub(super) fn of(tool: &str) -> Option<Self> {
        match tool {
            "nomoreide_list_services" | "nomoreide_status" => Some(Self::Empty),
            "nomoreide_start_service"
            | "nomoreide_stop_service"
            | "nomoreide_restart_service"
            | "nomoreide_start_bundle"
            | "nomoreide_stop_bundle"
            | "nomoreide_service_context"
            | "nomoreide_git_select_repository" => Some(Self::RequiredName),
            "nomoreide_service_health" => Some(Self::OptionalService),
            "nomoreide_register_service" => Some(Self::ServiceRegistration),
            "nomoreide_register_bundle" => Some(Self::BundleRegistration),
            "nomoreide_read_logs" => Some(Self::ServiceLogs),
            "nomoreide_timeline" => Some(Self::Timeline),
            "nomoreide_git_register_repository" => Some(Self::RepositoryRegistration),
            "nomoreide_git_status" | "nomoreide_git_branches" => Some(Self::GitCwd),
            "nomoreide_git_diff" | "nomoreide_git_staged_diff" => Some(Self::GitPath),
            "nomoreide_git_log" => Some(Self::GitLog),
            "nomoreide_git_worktrees" | "nomoreide_git_prune_worktrees" | "nomoreide_git_fetch" => {
                Some(Self::GitCwd)
            }
            "nomoreide_git_switch_branch" | "nomoreide_git_create_branch" => {
                Some(Self::GitBranchName)
            }
            "nomoreide_git_stage" | "nomoreide_git_unstage" => Some(Self::GitPaths),
            "nomoreide_git_commit" => Some(Self::GitCommit),
            "nomoreide_git_create_worktree" => Some(Self::WorktreeCreation),
            "nomoreide_git_push" => Some(Self::GitPush),
            "nomoreide_git_clone" => Some(Self::RepositoryClone),
            "nomoreide_github_set_token" => Some(Self::GithubToken),
            "nomoreide_github_list_prs" | "nomoreide_github_list_issues" => {
                Some(Self::GithubListing)
            }
            "nomoreide_github_get_pr"
            | "nomoreide_github_get_pr_diff"
            | "nomoreide_github_get_issue"
            | "nomoreide_github_list_issue_comments" => Some(Self::GithubNumber),
            "nomoreide_github_create_pr" => Some(Self::GithubPrCreation),
            "nomoreide_github_merge_pr" => Some(Self::GithubPrMerge),
            "nomoreide_github_add_issue_comment" => Some(Self::GithubComment),
            "nomoreide_github_create_issue" => Some(Self::GithubIssueCreation),
            "nomoreide_github_get_commit_ci" => Some(Self::GithubCommitSha),
            "nomoreide_github_list_workflow_runs" => Some(Self::GithubWorkflowRuns),
            "nomoreide_git_select_worktree" => Some(Self::WorktreeSelection),
            _ => None,
        }
    }

    pub(super) fn validate(&self, arguments: &Map<String, Value>) -> Result<(), String> {
        match self {
            Self::Empty => Ok(()),
            Self::RequiredName => required_name(arguments).map_err(|failure| failure.join(", ")),
            Self::ServiceLogs => {
                let mut failures = required_name(arguments).err().unwrap_or_default();
                failures.extend(bounded_integer(arguments, "limit", LOG_LIMIT_MAX));
                collect(failures)
            }
            Self::Timeline => {
                let mut failures = optional_name(arguments, "service");
                failures.extend(bounded_integer(arguments, "limit", TIMELINE_LIMIT_MAX));
                collect(failures)
            }
            Self::OptionalService => collect(optional_name(arguments, "service")),
            Self::RepositoryRegistration => {
                let mut failures = required_name(arguments).err().unwrap_or_default();
                failures.extend(required_string(arguments, "path").err().unwrap_or_default());
                collect(failures)
            }
            Self::GitCwd => collect(optional_name(arguments, "cwd")),
            // `cwd` first: it is the base schema the path is extended onto, so
            // it is also the first failure the reference reports.
            Self::GitPath => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(optional_name(arguments, "path"));
                collect(failures)
            }
            Self::GitLog => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(bounded_integer(arguments, "limit", COMMIT_LIMIT_MAX));
                collect(failures)
            }
            // In the reference's own key order, which is the order it reports
            // failures in: the base schema's `cwd` first, then the extension.
            Self::WorktreeCreation => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(
                    required_string(arguments, "branch")
                        .err()
                        .unwrap_or_default(),
                );
                failures.extend(boolean(arguments, "createBranch"));
                failures.extend(optional_name(arguments, "baseRef"));
                failures.extend(optional_name(arguments, "projectName"));
                collect(failures)
            }
            Self::GitBranchName => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(required_name(arguments).err().unwrap_or_default());
                collect(failures)
            }
            Self::GitPaths => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(string_array(arguments, "paths", ArrayShape::NAMES));
                collect(failures)
            }
            Self::GitCommit => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(
                    required_string(arguments, "message")
                        .err()
                        .unwrap_or_default(),
                );
                collect(failures)
            }
            Self::GitPush => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(optional_name(arguments, "remote"));
                collect(failures)
            }
            Self::RepositoryClone => {
                collect(required_string(arguments, "url").err().unwrap_or_default())
            }
            Self::GithubToken => {
                let mut failures = required_string(arguments, "token")
                    .err()
                    .unwrap_or_default();
                failures.extend(optional_name(arguments, "host"));
                collect(failures)
            }
            // Every one of these starts from the same optional `cwd`, and
            // reports it first, because it is the base schema the rest extends.
            Self::GithubListing => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(enumerated(arguments, "state", ISSUE_STATES));
                failures.extend(bounded_integer(arguments, "page", PAGE_MAX));
                collect(failures)
            }
            Self::GithubNumber => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(required_integer(arguments, "number"));
                collect(failures)
            }
            Self::GithubPrCreation => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(
                    required_string(arguments, "title")
                        .err()
                        .unwrap_or_default(),
                );
                failures.extend(optional_string(arguments, "body"));
                failures.extend(required_string(arguments, "head").err().unwrap_or_default());
                failures.extend(required_string(arguments, "base").err().unwrap_or_default());
                failures.extend(boolean(arguments, "draft"));
                collect(failures)
            }
            Self::GithubPrMerge => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(required_integer(arguments, "number"));
                failures.extend(enumerated(arguments, "method", MERGE_METHODS));
                failures.extend(optional_string(arguments, "commitTitle"));
                failures.extend(optional_string(arguments, "commitMessage"));
                collect(failures)
            }
            Self::GithubComment => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(required_integer(arguments, "number"));
                failures.extend(required_string(arguments, "body").err().unwrap_or_default());
                collect(failures)
            }
            Self::GithubIssueCreation => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(
                    required_string(arguments, "title")
                        .err()
                        .unwrap_or_default(),
                );
                failures.extend(optional_string(arguments, "body"));
                collect(failures)
            }
            Self::GithubCommitSha => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(required_string_of(arguments, "sha", SHA_MIN_LENGTH));
                collect(failures)
            }
            Self::GithubWorkflowRuns => {
                let mut failures = optional_name(arguments, "cwd");
                failures.extend(optional_string(arguments, "branch"));
                failures.extend(bounded_integer(arguments, "page", PAGE_MAX));
                collect(failures)
            }
            Self::WorktreeSelection => {
                let mut failures = required_string(arguments, "repository")
                    .err()
                    .unwrap_or_default();
                failures.extend(required_string(arguments, "path").err().unwrap_or_default());
                collect(failures)
            }
            // In the reference's own key order, which is the order it reports
            // failures in.
            Self::ServiceRegistration => {
                let mut failures = required_name(arguments).err().unwrap_or_default();
                failures.extend(enumerated(arguments, "kind", SERVICE_KINDS));
                failures.extend(optional_name(arguments, "command"));
                failures.extend(string_array(arguments, "args", ArrayShape::ANY));
                failures.extend(optional_name(arguments, "cwd"));
                failures.extend(bounded_integer(arguments, "port", PORT_MAX));
                failures.extend(string_map(arguments, "env"));
                failures.extend(optional_string(arguments, "description"));
                failures.extend(optional_name(arguments, "composeFile"));
                failures.extend(optional_name(arguments, "composeService"));
                failures.extend(optional_name(arguments, "host"));
                collect(failures)
            }
            Self::BundleRegistration => {
                let mut failures = required_name(arguments).err().unwrap_or_default();
                failures.extend(string_array(arguments, "services", ArrayShape::NAMES));
                collect(failures)
            }
        }
    }
}

fn collect(failures: Vec<String>) -> Result<(), String> {
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join(", "))
    }
}

fn required_name(arguments: &Map<String, Value>) -> Result<(), Vec<String>> {
    required_string(arguments, "name")
}

/// A required non-empty string under `key`, reported the way zod reports it.
fn required_string(arguments: &Map<String, Value>, key: &str) -> Result<(), Vec<String>> {
    let failure = match arguments.get(key) {
        None => format!("{key}: Required"),
        Some(Value::String(value)) if value.is_empty() => {
            format!("{key}: String must contain at least 1 character(s)")
        }
        Some(Value::String(_)) => return Ok(()),
        Some(other) => format!("{key}: Expected string, received {}", schema_type(other)),
    };
    Err(vec![failure])
}

/// A required positive integer with no upper bound of its own.
fn required_integer(arguments: &Map<String, Value>, key: &str) -> Vec<String> {
    if arguments.get(key).is_none() {
        return vec![format!("{key}: Required")];
    }
    bounded_integer(arguments, key, PAGE_MAX)
}

/// A required string of at least `minimum` characters, counted the way zod
/// counts them — by UTF-16 code unit, not by byte.
fn required_string_of(arguments: &Map<String, Value>, key: &str, minimum: usize) -> Vec<String> {
    match arguments.get(key) {
        None => vec![format!("{key}: Required")],
        Some(Value::String(value)) if value.encode_utf16().count() >= minimum => Vec::new(),
        Some(Value::String(_)) => vec![format!(
            "{key}: String must contain at least {minimum} character(s)"
        )],
        Some(other) => vec![format!(
            "{key}: Expected string, received {}",
            schema_type(other)
        )],
    }
}

/// An optional non-empty string. Absent is valid; present and empty is not,
/// because the reference asks for `.min(1)` either way.
fn optional_name(arguments: &Map<String, Value>, key: &str) -> Vec<String> {
    match arguments.get(key) {
        None => Vec::new(),
        Some(Value::String(value)) if value.is_empty() => {
            vec![format!(
                "{key}: String must contain at least 1 character(s)"
            )]
        }
        Some(Value::String(_)) => Vec::new(),
        Some(other) => vec![format!(
            "{key}: Expected string, received {}",
            schema_type(other)
        )],
    }
}

/// An optional positive integer with an inclusive upper bound.
///
/// A value of the wrong type fails on that alone, but a number is then checked
/// against all three of `int`, `positive`, and `max` — so `1000.5` reports both
/// that it is not an integer and that it is out of range, exactly as the
/// reference does. Integer-ness is a property of the value, not of how it was
/// written: the reference treats `1e20` as an integer, and so does this.
fn bounded_integer(arguments: &Map<String, Value>, key: &str, max: f64) -> Vec<String> {
    let Some(value) = arguments.get(key) else {
        return Vec::new();
    };
    let Some(number) = value.as_f64().filter(|_| value.is_number()) else {
        return vec![format!(
            "{key}: Expected number, received {}",
            schema_type(value)
        )];
    };
    let mut failures = Vec::new();
    if number.fract() != 0.0 {
        failures.push(format!("{key}: Expected integer, received float"));
    }
    if number <= 0.0 {
        failures.push(format!("{key}: Number must be greater than 0"));
    } else if number > max {
        failures.push(format!("{key}: Number must be less than or equal to {max}"));
    }
    failures
}

/// An optional boolean. The reference gives this one a default, so only a
/// present value of the wrong type can fail.
fn boolean(arguments: &Map<String, Value>, key: &str) -> Vec<String> {
    match arguments.get(key) {
        None | Some(Value::Bool(_)) => Vec::new(),
        Some(other) => vec![format!(
            "{key}: Expected boolean, received {}",
            schema_type(other)
        )],
    }
}

/// A plain optional string, with nothing said about its length.
fn optional_string(arguments: &Map<String, Value>, key: &str) -> Vec<String> {
    match arguments.get(key) {
        None | Some(Value::String(_)) => Vec::new(),
        Some(other) => vec![format!(
            "{key}: Expected string, received {}",
            schema_type(other)
        )],
    }
}

/// An optional member of a fixed set. A value of the wrong type is reported
/// differently from a string that is simply not one of the members — the
/// reference says "Invalid enum value" only when it had a string to compare.
fn enumerated(arguments: &Map<String, Value>, key: &str, members: &[&str]) -> Vec<String> {
    let expected = members
        .iter()
        .map(|member| format!("'{member}'"))
        .collect::<Vec<_>>()
        .join(" | ");
    match arguments.get(key) {
        None => Vec::new(),
        Some(Value::String(value)) if members.contains(&value.as_str()) => Vec::new(),
        Some(Value::String(value)) => vec![format!(
            "{key}: Invalid enum value. Expected {expected}, received '{value}'"
        )],
        Some(other) => vec![format!(
            "{key}: Expected {expected}, received {}",
            schema_type(other)
        )],
    }
}

/// What an array of strings has to satisfy beyond being one.
struct ArrayShape {
    /// Whether the array itself may be empty.
    allow_empty: bool,
    /// Whether an individual member may be the empty string.
    allow_empty_members: bool,
}

impl ArrayShape {
    /// `z.array(z.string())` — `args`, whose members are passed to a program
    /// verbatim and so may be anything a program accepts, empty included.
    const ANY: Self = Self {
        allow_empty: true,
        allow_empty_members: true,
    };
    /// `z.array(z.string().min(1)).min(1)` — a bundle's members, each of which
    /// has to name something.
    const NAMES: Self = Self {
        allow_empty: false,
        allow_empty_members: false,
    };
}

/// An optional array of strings. Every member is reported, not just the first,
/// and each is addressed by its index the way the reference addresses it.
fn string_array(arguments: &Map<String, Value>, key: &str, shape: ArrayShape) -> Vec<String> {
    let Some(value) = arguments.get(key) else {
        return if shape.allow_empty {
            Vec::new()
        } else {
            vec![format!("{key}: Required")]
        };
    };
    let Some(members) = value.as_array() else {
        return vec![format!(
            "{key}: Expected array, received {}",
            schema_type(value)
        )];
    };
    if members.is_empty() && !shape.allow_empty {
        return vec![format!("{key}: Array must contain at least 1 element(s)")];
    }
    members
        .iter()
        .enumerate()
        .filter_map(|(index, member)| match member {
            Value::String(member) if member.is_empty() && !shape.allow_empty_members => Some(
                format!("{key}.{index}: String must contain at least 1 character(s)"),
            ),
            Value::String(_) => None,
            other => Some(format!(
                "{key}.{index}: Expected string, received {}",
                schema_type(other)
            )),
        })
        .collect()
}

/// An optional map of string values, addressed by key.
///
/// The reference walks the map in insertion order; `serde_json` sorts object
/// keys, so two bad entries are reported alphabetically rather than as written.
/// Which entries are reported, and what is said about each, is the same.
fn string_map(arguments: &Map<String, Value>, key: &str) -> Vec<String> {
    let Some(value) = arguments.get(key) else {
        return Vec::new();
    };
    let Some(entries) = value.as_object() else {
        return vec![format!(
            "{key}: Expected object, received {}",
            schema_type(value)
        )];
    };
    entries
        .iter()
        .filter(|(_, value)| !value.is_string())
        .map(|(name, value)| {
            format!(
                "{key}.{name}: Expected string, received {}",
                schema_type(value)
            )
        })
        .collect()
}

fn schema_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
