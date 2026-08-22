//! The write-capable half of Git, exercised against real repositories.
//!
//! Ported from `test/git-actions.test.ts` so the two runtimes are held to the
//! same behaviour. The credential cases matter most: they are the reason this
//! code lives in its own crate.

use nomoreide_actions::git::{credential_config_args, redact, GitActions, PushCredential};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// A repository with one commit on `main` and a bare remote at `origin`.
struct Fixture {
    repo: PathBuf,
    remote: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let unique = format!(
            "nomoreide-actions-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let repo = std::env::temp_dir().join(&unique);
        let remote = std::env::temp_dir().join(format!("{unique}-remote"));
        std::fs::create_dir_all(&repo).expect("create repo dir");
        std::fs::create_dir_all(&remote).expect("create remote dir");

        git(&repo, &["init", "--initial-branch=main"]);
        git(&repo, &["config", "user.email", "nomoreide@example.test"]);
        git(&repo, &["config", "user.name", "NoMoreIDE Test"]);
        // A hook or a signing key from the developer's own config would derail
        // the commits below, so keep the fixture from inheriting either.
        git(&repo, &["config", "commit.gpgsign", "false"]);
        write(&repo, "README.md", "initial\n");
        git(&repo, &["add", "README.md"]);
        git(&repo, &["commit", "-m", "initial commit"]);

        git(&remote, &["init", "--bare", "--initial-branch=main"]);
        git(
            &repo,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        );

        Self { repo, remote }
    }

    fn actions(&self) -> GitActions {
        GitActions::new(self.repo.to_string_lossy().into_owned())
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.repo, args)
    }

    fn write(&self, name: &str, contents: &str) {
        write(&self.repo, name, contents);
    }

    fn commit(&self, name: &str, contents: &str, message: &str) {
        self.write(name, contents);
        self.git(&["add", name]);
        self.git(&["commit", "-m", message]);
    }

    fn branch(&self) -> String {
        self.git(&["rev-parse", "--abbrev-ref", "HEAD"])
            .trim()
            .to_string()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.repo);
        let _ = std::fs::remove_dir_all(&self.remote);
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git should run");
    assert!(
        out.status.success(),
        "git {args:?} failed in {}: {}",
        cwd.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn write(cwd: &Path, name: &str, contents: &str) {
    std::fs::write(cwd.join(name), contents).expect("write fixture file");
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(future)
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

#[test]
fn sets_upstream_on_first_push_and_reports_it() {
    let fixture = Fixture::new("push-first");

    let result = block_on(fixture.actions().push(None, None)).expect("push");

    assert_eq!(result.branch, "main");
    assert!(result.set_upstream);
    assert_eq!(
        fixture
            .git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
            .trim(),
        "origin/main"
    );
}

#[test]
fn pushes_subsequent_commits_without_re_setting_upstream() {
    let fixture = Fixture::new("push-again");
    block_on(fixture.actions().push(None, None)).expect("first push");

    fixture.commit("next.txt", "next\n", "next");
    let result = block_on(fixture.actions().push(None, None)).expect("second push");

    assert!(!result.set_upstream);
    assert!(
        fixture
            .git(&["rev-list", "--count", "@{u}..HEAD"])
            .trim()
            .parse::<u32>()
            .unwrap()
            == 0,
        "branch should be in sync after pushing"
    );
}

#[test]
fn refuses_to_push_a_detached_head() {
    let fixture = Fixture::new("push-detached");
    let head = fixture.git(&["rev-parse", "HEAD"]).trim().to_string();
    fixture.git(&["checkout", &head]);

    let error = block_on(fixture.actions().push(None, None)).expect_err("detached HEAD");

    assert!(
        error.to_string().contains("detached HEAD"),
        "unexpected error: {error}"
    );
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

#[test]
fn the_helper_supplies_the_passed_token_and_overrides_inherited_helpers() {
    let fixture = Fixture::new("credential-helper");
    // A machine-level helper that would otherwise answer first — the reset in
    // credential_config_args() must stop it winning and pushing as the wrong
    // account.
    fixture.git(&[
        "config",
        "credential.helper",
        r#"!f() { echo "username=machine-account"; echo "password=machine-token"; }; f"#,
    ]);

    let mut args: Vec<String> = credential_config_args();
    args.push("credential".to_string());
    args.push("fill".to_string());

    let mut child = Command::new("git")
        .args(&args)
        .current_dir(&fixture.repo)
        .env("NOMOREIDE_GIT_USERNAME", "x-access-token")
        .env("NOMOREIDE_GIT_PASSWORD", "selected-account-token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("git credential fill");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(b"protocol=https\nhost=github.com\n\n")
            .expect("write credential request");
    }
    let out = child.wait_with_output().expect("credential fill output");
    let stdout = String::from_utf8_lossy(&out.stdout);

    assert!(stdout.contains("username=x-access-token"), "got: {stdout}");
    assert!(
        stdout.contains("password=selected-account-token"),
        "got: {stdout}"
    );
    assert!(
        !stdout.contains("machine-token"),
        "the inherited helper answered: {stdout}"
    );
}

#[test]
fn the_token_never_reaches_argv() {
    // The whole point of the helper: the secret travels in the environment, so
    // nothing in the argument vector should carry it.
    let args = credential_config_args();
    assert!(
        args.iter().all(|arg| !arg.contains("secret-token")),
        "unexpected: {args:?}"
    );
    assert_eq!(args[0], "-c");
    assert_eq!(
        args[1], "credential.helper=",
        "the inherited helper chain must be reset first"
    );
    assert!(args[3].starts_with("credential.helper=!f()"));
    assert!(args[3].contains("$NOMOREIDE_GIT_PASSWORD"));
}

#[test]
fn redacts_the_token_from_anything_surfaced_to_the_ui() {
    assert_eq!(
        redact(
            "remote: rejected using tok-123 twice: tok-123",
            Some("tok-123")
        ),
        "remote: rejected using *** twice: ***"
    );
    assert_eq!(redact("no secret here", None), "no secret here");
    assert_eq!(redact("no secret here", Some("")), "no secret here");
}

#[test]
fn everything_the_runner_returns_has_passed_through_redaction() {
    // Git strips credentials out of the URLs it echoes, so a plausible-looking
    // token would never appear in this output and the test would pass whether
    // or not redaction ran. Use a token git is *certain* to echo — the branch
    // name it reports pushing — so the assertion actually exercises the scrub.
    let fixture = Fixture::new("push-redact");

    let result = block_on(fixture.actions().push(
        None,
        Some(PushCredential {
            token: "main",
            username: None,
        }),
    ))
    .expect("push");

    assert!(
        result.output.contains("***"),
        "expected the token to be scrubbed, got: {}",
        result.output
    );
    assert!(
        !result.output.contains("main"),
        "token survived into: {}",
        result.output
    );
    // The branch comes from an uncredentialed call, so it is reported as-is.
    assert_eq!(result.branch, "main");
}

// ---------------------------------------------------------------------------
// pull / merge / rebase
// ---------------------------------------------------------------------------

#[test]
fn pulls_the_current_branch_with_fast_forward_only_semantics() {
    let fixture = Fixture::new("pull");
    block_on(fixture.actions().push(None, None)).expect("push");

    let output = block_on(fixture.actions().pull()).expect("pull");

    let lowered = output.to_lowercase();
    assert!(
        lowered.contains("up to date") || lowered.contains("up-to-date"),
        "unexpected pull output: {output}"
    );
}

#[test]
fn merges_another_branch_into_the_current_branch() {
    let fixture = Fixture::new("merge");
    fixture.git(&["checkout", "-b", "feature/merge-me"]);
    fixture.commit("merged.txt", "merged\n", "merge me");
    fixture.git(&["checkout", "main"]);

    block_on(fixture.actions().merge("feature/merge-me")).expect("merge");

    assert_eq!(
        fixture.git(&["log", "-1", "--format=%s"]).trim(),
        "merge me"
    );
}

#[test]
fn rebases_the_current_branch_onto_another_branch() {
    let fixture = Fixture::new("rebase");
    fixture.git(&["checkout", "-b", "feature/base"]);
    fixture.commit("base.txt", "base\n", "base change");
    let base_head = fixture.git(&["rev-parse", "HEAD"]).trim().to_string();
    fixture.git(&["checkout", "main"]);
    fixture.git(&["checkout", "-b", "feature/topic"]);
    fixture.commit("topic.txt", "topic\n", "topic change");

    block_on(fixture.actions().rebase("feature/base")).expect("rebase");

    assert_eq!(
        fixture
            .git(&["merge-base", "HEAD", "feature/base"])
            .trim()
            .to_string(),
        base_head
    );
    assert_eq!(fixture.branch(), "feature/topic");
}

#[test]
fn rejects_merge_and_rebase_when_local_changes_are_present() {
    let fixture = Fixture::new("dirty");
    fixture.git(&["checkout", "-b", "feature/other"]);
    fixture.git(&["checkout", "main"]);
    fixture.write("dirty.txt", "dirty\n");

    let merge_error = block_on(fixture.actions().merge("feature/other")).expect_err("dirty merge");
    let rebase_error =
        block_on(fixture.actions().rebase("feature/other")).expect_err("dirty rebase");

    assert_eq!(
        merge_error.to_string(),
        "Commit or stash local changes before merge."
    );
    assert_eq!(
        rebase_error.to_string(),
        "Commit or stash local changes before rebase."
    );
}

#[test]
fn aborts_a_conflicting_rebase_instead_of_leaving_it_in_progress() {
    let fixture = Fixture::new("rebase-conflict");
    fixture.git(&["checkout", "-b", "feature/base"]);
    fixture.commit("README.md", "base\n", "base README");
    fixture.git(&["checkout", "main"]);
    fixture.git(&["checkout", "-b", "feature/topic"]);
    fixture.commit("README.md", "topic\n", "topic README");

    let error = block_on(fixture.actions().rebase("feature/base")).expect_err("conflicting rebase");

    assert!(
        error
            .to_string()
            .starts_with("Rebase failed and was aborted."),
        "unexpected error: {error}"
    );
    assert_eq!(fixture.branch(), "feature/topic");
    assert_eq!(fixture.git(&["status", "--porcelain"]).trim(), "");
}

#[test]
fn refuses_a_branch_name_that_could_be_read_as_an_option() {
    let fixture = Fixture::new("branch-ref");

    for name in ["", "   ", "--force"] {
        assert!(
            block_on(fixture.actions().merge(name)).is_err(),
            "expected merge({name:?}) to be refused"
        );
        assert!(
            block_on(fixture.actions().rebase(name)).is_err(),
            "expected rebase({name:?}) to be refused"
        );
    }
}

// ---------------------------------------------------------------------------
// pull_default
// ---------------------------------------------------------------------------

#[test]
fn returns_to_the_default_branch_and_fast_forwards_it() {
    let fixture = Fixture::new("pull-default");
    block_on(fixture.actions().push(None, None)).expect("push");
    // `origin/HEAD` is what the default branch is read from; a fresh clone gets
    // it automatically, a `remote add` does not.
    fixture.git(&["remote", "set-head", "origin", "main"]);
    fixture.git(&["checkout", "-b", "feature/work"]);

    let result = block_on(fixture.actions().pull_default(None)).expect("pull_default");

    assert_eq!(fixture.branch(), "main");
    // The branch is reported rather than left for the caller to work out from
    // git's text — the desktop app used to invent an empty one here.
    assert_eq!(result.branch, "main");
    assert!(
        result.output.starts_with("Switched to main."),
        "{}",
        result.output
    );
}

/// A repository whose remote was added by hand has no `origin/HEAD`, which is
/// the common case this used to answer with a guess.
#[test]
fn a_missing_remote_head_falls_back_to_a_local_default() {
    let fixture = Fixture::new("pull-default-fallback");
    block_on(fixture.actions().push(None, None)).expect("push");
    fixture.git(&["checkout", "-b", "feature/work"]);

    let result = block_on(fixture.actions().pull_default(None)).expect("pull_default");

    assert_eq!(result.branch, "main");
}

/// And one with no `main`, no `master`, and no remote head is a repository this
/// cannot answer for — which is a refusal, not `main`.
#[test]
fn a_repository_with_no_recognisable_default_is_refused() {
    let fixture = Fixture::new("pull-default-unknown");
    fixture.git(&["branch", "-m", "trunk"]);

    let error = block_on(fixture.actions().pull_default(None)).expect_err("no default");

    assert_eq!(
        error.to_string(),
        "Could not determine default branch for origin."
    );
}

#[test]
fn debugging_a_credential_does_not_print_the_token() {
    let rendered = format!(
        "{:?}",
        PushCredential {
            token: "tok-secret",
            username: Some("x-access-token"),
        }
    );

    assert!(!rendered.contains("tok-secret"), "got: {rendered}");
    assert!(rendered.contains("x-access-token"), "got: {rendered}");
}
