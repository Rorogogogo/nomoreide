//! Running a candidate command briefly, to answer "does this actually start?"
//!
//! This is the probe behind the dashboard's "test" button on the add-a-service
//! form. It is **not** the service runtime: nothing is registered, nothing is
//! journaled, and the child is killed as soon as the question is answered.
//!
//! The question has three possible answers and they are not the same shape:
//!
//! - the command **exited** — success is exit code 0, and the report carries
//!   the code and signal;
//! - the command **stayed running** for the timeout — that is the success case
//!   for a server, and the report carries no exit code at all, because there
//!   was none;
//! - a `port` was given and the command stayed running **without opening it** —
//!   running but not listening, which is a failure a plain exit code would have
//!   called success.
//!
//! The child is started in its own process group and the group is signalled, so
//! a command that spawns a shell which spawns a server does not leave the
//! server behind.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::env_file;
use crate::port_utils::is_port_available;

pub struct ServiceTestRequest {
    pub command: String,
    /// `None` runs the command through a shell, which is what the legacy
    /// single-string form means. `Some` executes it directly with these
    /// arguments and no shell at all.
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub cwd: String,
    pub port: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTestResult {
    pub ok: bool,
    pub message: String,
    /// **A pair, present or absent together.** A run that ended has both keys,
    /// and the one that does not apply is `null`; a run that was still going
    /// when the clock ran out has neither, because it did not end. The nesting
    /// carries that: the outer `None` omits the key, the inner `None` writes
    /// null.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<Option<i32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<Option<String>>,
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
}

const TIMEOUT: Duration = Duration::from_millis(2500);

pub async fn test_service_command(request: ServiceTestRequest) -> ServiceTestResult {
    if let Some(port) = request.port {
        if !is_port_available("127.0.0.1", port) {
            return ServiceTestResult {
                ok: false,
                message: format!("Port {port} is already in use."),
                exit_code: None,
                signal: None,
                stdout: Vec::new(),
                stderr: Vec::new(),
            };
        }
    }

    // The service's own `.env` is layered under the caller's `env`, so a test
    // runs with what a real launch would see rather than with a bare
    // environment.
    let file_env: HashMap<String, String> = env_file::read(format!("{}/.env", request.cwd))
        .await
        .ok()
        .flatten()
        .map(|lines| {
            env_file::entries(&lines)
                .into_iter()
                .map(|entry| (entry.key, entry.value))
                .collect()
        })
        .unwrap_or_default();

    let mut child = match spawn(&request, &file_env) {
        Ok(child) => child,
        Err(reason) => {
            return ServiceTestResult {
                ok: false,
                message: reason,
                exit_code: Some(Some(1)),
                signal: Some(None),
                stdout: Vec::new(),
                stderr: Vec::new(),
            }
        }
    };

    let stdout = collect(child.stdout.take());
    let stderr = collect(child.stderr.take());

    let outcome = tokio::time::timeout(TIMEOUT, child.wait()).await;
    // A reader that panicked leaves no lines rather than failing the probe:
    // what the command did is still worth reporting.
    let (out, err) = (
        stdout.await.unwrap_or_default(),
        stderr.await.unwrap_or_default(),
    );

    match outcome {
        Ok(Ok(status)) => {
            let code = status.code();
            let signal = termination_signal(&status);
            ServiceTestResult {
                ok: code == Some(0),
                message: if code == Some(0) {
                    "Command completed successfully.".to_string()
                } else {
                    let shown = code
                        .map(|code| code.to_string())
                        .or_else(|| signal.clone())
                        .unwrap_or_else(|| "unknown".to_string());
                    format!("Command exited with code {shown}.")
                },
                exit_code: Some(code),
                signal: Some(signal),
                stdout: out,
                stderr: err,
            }
        }
        Ok(Err(error)) => ServiceTestResult {
            ok: false,
            message: error.to_string(),
            exit_code: Some(Some(1)),
            signal: Some(None),
            stdout: out,
            stderr: err,
        },
        // Still running when the clock ran out, which for a server is the
        // answer the caller wanted.
        Err(_) => {
            let opened = request
                .port
                .map(|port| !is_port_available("127.0.0.1", port));
            terminate(&mut child).await;
            let message = match (request.port, opened) {
                (Some(port), Some(true)) => format!("Command started and opened port {port}."),
                (Some(port), _) => {
                    format!("Command stayed running, but port {port} did not open.")
                }
                _ => "Command stayed running long enough to test startup.".to_string(),
            };
            ServiceTestResult {
                ok: opened.unwrap_or(true),
                message,
                exit_code: None,
                signal: None,
                stdout: out,
                stderr: err,
            }
        }
    }
}

fn spawn(
    request: &ServiceTestRequest,
    file_env: &HashMap<String, String>,
) -> Result<tokio::process::Child, String> {
    let mut command = match &request.args {
        Some(args) => {
            let mut command = Command::new(&request.command);
            command.args(args);
            command
        }
        None => {
            let mut command = Command::new("/bin/sh");
            command.arg("-c").arg(&request.command);
            command
        }
    };
    command
        .current_dir(&request.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in file_env {
        command.env(key, value);
    }
    for (key, value) in request.env.iter().flatten() {
        command.env(key, value);
    }
    #[cfg(unix)]
    command.process_group(0);
    // Node's wording, because the message is reported verbatim to the person
    // testing the command: `spawn <program> <ERRNO>`. A cwd that does not exist
    // surfaces here as an ENOENT against the *program*, which is what Node says
    // too — it does not distinguish which of the two was missing.
    let program = match &request.args {
        Some(_) => request.command.clone(),
        None => "/bin/sh".to_string(),
    };
    command
        .spawn()
        .map_err(|error| format!("spawn {program} {}", errno_name(&error)))
}

/// Read a pipe to exhaustion, keeping non-blank lines.
fn collect<R>(stream: Option<R>) -> tokio::task::JoinHandle<Vec<String>>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = Vec::new();
        let Some(stream) = stream else {
            return lines;
        };
        let mut reader = BufReader::new(stream).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if !line.trim().is_empty() {
                lines.push(line);
            }
        }
        lines
    })
}

async fn terminate(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // The whole group: a shell command that started a server has the server
        // as a sibling, not as this child.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
    let _ = child.kill().await;
}

/// The signal's **name**, never its number: signal numbers differ by platform,
/// and a report that says `9` is a report a reader has to look up.
fn termination_signal(status: &std::process::ExitStatus) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status
            .signal()
            .and_then(crate::process_manager::signal_name)
            .map(str::to_string)
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

/// The errno name Node prints for a spawn failure.
fn errno_name(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        _ => match error.raw_os_error() {
            Some(libc::ENOTDIR) => "ENOTDIR",
            Some(libc::ENOEXEC) => "ENOEXEC",
            Some(libc::EMFILE) => "EMFILE",
            _ => "UNKNOWN",
        },
    }
}
