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

#[tokio::main]
async fn main() -> ExitCode {
    nomoreide_cli::run().await
}
