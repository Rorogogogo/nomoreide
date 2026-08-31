//! `execFile`, including how it reports a failure.
//!
//! Several surfaces run a program, hand the caller its output, and hand the
//! caller Node's *own* failure wording when it exits non-zero — the message is
//! rendered where the output would have gone, so it is part of the answer
//! rather than a log line. Node words it
//! `Command failed: <file> <args…>\n<stderr>`, which means the full argv is
//! quoted back, embedded remote scripts and all.
//!
//! Bytes rather than a `String`, because a file preview may be binary and the
//! caller decides how to decode it. The one place a lossy decode is forced is
//! the error message, which is text by construction.

use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

pub struct ExecOptions<'a> {
    pub timeout: Duration,
    /// Node kills the child and rejects once either stream passes this. Here
    /// the child has already finished, so it is checked after the fact — the
    /// difference is invisible in the answer and visible only in how long a
    /// runaway program is allowed to run.
    pub max_buffer: usize,
    pub cwd: Option<&'a str>,
}

#[derive(Debug)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// The program ran and said something. `failure` is set when it exited
/// non-zero — the output is still there, because Node hangs `stdout` on the
/// error object and one caller reads it.
pub struct ExecAttempt {
    pub output: ExecOutput,
    pub failure: Option<String>,
}

/// Run a program, and hand back what it printed **even when it failed**.
///
/// `claude mcp list` is why this exists: it prints a usable table and then
/// exits non-zero, and the reference parses the table anyway. An `Err` here is
/// only for a run that produced nothing to read — a spawn failure, a timeout,
/// or output past the buffer.
pub async fn exec_file_capturing(
    argv: &[String],
    options: &ExecOptions<'_>,
) -> Result<ExecAttempt, String> {
    let (program, args) = argv.split_first().ok_or("no command")?;
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = options.cwd.filter(|value| !value.is_empty()) {
        command.current_dir(cwd);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("spawn {program} {}", errno_name(&error)))?;
    let output = tokio::time::timeout(options.timeout, child.wait_with_output())
        .await
        .map_err(|_| format!("Command failed: {}", argv.join(" ")))?
        .map_err(|error| error.to_string())?;

    if output.stdout.len() > options.max_buffer || output.stderr.len() > options.max_buffer {
        return Err("stdout maxBuffer length exceeded".to_string());
    }
    let failure = (!output.status.success()).then(|| {
        format!(
            "Command failed: {}\n{}",
            argv.join(" "),
            String::from_utf8_lossy(&output.stderr)
        )
    });
    Ok(ExecAttempt {
        output: ExecOutput {
            stdout: output.stdout,
            stderr: output.stderr,
        },
        failure,
    })
}

/// The common case: a non-zero exit is a failure and the output is discarded.
pub async fn exec_file(argv: &[String], options: &ExecOptions<'_>) -> Result<ExecOutput, String> {
    let attempt = exec_file_capturing(argv, options).await?;
    match attempt.failure {
        Some(failure) => Err(failure),
        None => Ok(attempt.output),
    }
}

/// The `code` Node puts on a spawn failure, which callers quote rather than the
/// operating system's prose.
fn errno_name(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        _ => "EIO",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> ExecOptions<'static> {
        ExecOptions {
            timeout: Duration::from_secs(10),
            max_buffer: 1024 * 1024,
            cwd: None,
        }
    }

    #[tokio::test]
    async fn a_failure_quotes_the_whole_command_and_then_stderr() {
        let argv = vec![
            "sh".to_string(),
            "-c".to_string(),
            "printf 'went wrong\n' >&2; exit 3".to_string(),
        ];
        let failure = exec_file(&argv, &options()).await.unwrap_err();
        assert_eq!(
            failure,
            "Command failed: sh -c printf 'went wrong\n' >&2; exit 3\nwent wrong\n"
        );
    }

    #[tokio::test]
    async fn output_comes_back_as_bytes() {
        let argv = vec![
            "sh".to_string(),
            "-c".to_string(),
            r"printf 'a\0b'".to_string(),
        ];
        let output = exec_file(&argv, &options()).await.unwrap();
        assert_eq!(output.stdout, vec![b'a', 0, b'b']);
    }
}
