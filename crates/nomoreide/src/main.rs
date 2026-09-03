//! The name people type.
//!
//! `cargo install nomoreide` is what someone reaches for after meeting the
//! tool as `nomoreide` — at a shell prompt, in `install.sh`, or as
//! `npm install -g nomoreide`. Before this crate existed that command failed,
//! and the working one named an implementation detail: `nomoreide-cli`.
//!
//! So this is a front door rather than a second copy. Every line of the
//! command line lives in `nomoreide-cli`, which exposes it as
//! [`nomoreide_cli::run`]; both crates install a binary called `nomoreide`,
//! and the two are the same program.

use std::process::ExitCode;

/// Die quietly when the thing reading us stops reading.
///
/// Rust's runtime sets `SIGPIPE` to `SIG_IGN` before `main`, so a write to a
/// closed pipe comes back as `EPIPE`, and the standard library's answer to a
/// failed `println!` is a panic. For a library that is a reasonable default.
/// For a command in a pipeline it is wrong: `nomoreide list | head -1` ends
/// with an abort and a panic message rather than the one line you asked for,
/// and the release smoke test — `nomoreide setup | grep -q ...` — aborted for
/// exactly this reason, which is how it was noticed.
///
/// Restoring the default disposition makes this behave like every other Unix
/// tool: the process is killed by the signal, silently, and whatever is
/// downstream never learns there was almost more.
#[cfg(unix)]
fn die_quietly_on_a_closed_pipe() {
    // Safe: setting a signal disposition before any thread exists, to the
    // value the process would have had if Rust had not changed it.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
}

#[cfg(not(unix))]
fn die_quietly_on_a_closed_pipe() {}

#[tokio::main]
async fn main() -> ExitCode {
    die_quietly_on_a_closed_pipe();
    nomoreide_cli::run().await
}
