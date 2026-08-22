//! Docker Compose services.
//!
//! A compose service is the one registered kind this runtime does not own a
//! process for. `docker compose up -d` returns as soon as the container is
//! started, and what keeps running afterwards belongs to the Docker daemon —
//! so there is no child to supervise, no process group to clean up, and
//! nothing to journal against a crash. What identifies the running service is
//! a container id, read back from `docker compose ps`.
//!
//! Everything here builds an argument vector and runs it; no string ever
//! reaches a shell.

use anyhow::{anyhow, Result};
use tokio::process::Command;

use crate::config::ServiceDef;

/// The compose project and service an entry in config points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposeTarget {
    pub cwd: String,
    pub compose_file: Option<String>,
    pub compose_service: String,
}

impl ComposeTarget {
    /// Both fields are required and neither is defaulted: without a `cwd`
    /// there is no compose project to act on, and without a `composeService`
    /// the command would act on every service in it.
    pub fn of(def: &ServiceDef) -> Result<Self> {
        let missing = || {
            anyhow!(
                "Service \"{}\" is missing docker-compose cwd or composeService.",
                def.name
            )
        };
        let cwd = def
            .cwd
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(missing)?;
        let compose_service = def
            .compose_service
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(missing)?;
        Ok(Self {
            cwd: cwd.to_string(),
            compose_file: def
                .compose_file
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string),
            compose_service: compose_service.to_string(),
        })
    }

    /// `docker compose [-f <file>] <verb…> <service>`, the way the reference
    /// builds it.
    fn argv(&self, verb: &[&str]) -> Vec<String> {
        let mut args = vec!["compose".to_string()];
        if let Some(file) = &self.compose_file {
            args.push("-f".to_string());
            args.push(file.clone());
        }
        args.extend(verb.iter().map(|part| (*part).to_string()));
        args.push(self.compose_service.clone());
        args
    }

    pub fn up_argv(&self) -> Vec<String> {
        self.argv(&["up", "-d"])
    }

    pub fn stop_argv(&self) -> Vec<String> {
        self.argv(&["stop"])
    }

    pub fn ps_argv(&self) -> Vec<String> {
        self.argv(&["ps", "--format", "json"])
    }
}

/// What `docker compose ps` says about the service's container.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContainerInfo {
    pub container_id: Option<String>,
    pub state: Option<String>,
}

/// Runs compose verbs against the Docker CLI.
///
/// The program is a field rather than a constant so a test can point the whole
/// runtime at a stand-in and exercise the compose paths on a machine with no
/// Docker on it.
#[derive(Debug, Clone)]
pub struct Compose {
    program: String,
}

impl Default for Compose {
    fn default() -> Self {
        Self {
            program: "docker".to_string(),
        }
    }
}

impl Compose {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_program(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
        }
    }

    /// Bring the service up and report the container that resulted.
    pub async fn start(&self, target: &ComposeTarget) -> Result<ContainerInfo> {
        self.run(target, target.up_argv()).await?;
        Ok(self.read_status(target).await)
    }

    pub async fn stop(&self, target: &ComposeTarget) -> Result<()> {
        self.run(target, target.stop_argv()).await.map(|_| ())
    }

    /// The container behind the service, or nothing at all.
    ///
    /// A failure to ask is not a failure of the service: compose exits
    /// non-zero for a project that is simply not up, and the reference reads
    /// that as "no container" rather than as an error to propagate.
    pub async fn read_status(&self, target: &ComposeTarget) -> ContainerInfo {
        match self.run(target, target.ps_argv()).await {
            Ok(stdout) => parse_ps_output(&stdout),
            Err(_) => ContainerInfo::default(),
        }
    }

    async fn run(&self, target: &ComposeTarget, args: Vec<String>) -> Result<String> {
        let output = Command::new(&self.program)
            .args(&args)
            .current_dir(&target.cwd)
            .env("PATH", crate::process_manager::service_path())
            .output()
            .await
            .map_err(|error| anyhow!("{} could not be run: {error}", self.program))?;
        if !output.status.success() {
            return Err(anyhow!(
                "{} {} failed: {}",
                self.program,
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

/// `docker compose ps --format json` writes one JSON object per line. The
/// first line carrying an id wins; anything unparseable is skipped, because a
/// compose version that prefixes a warning should not cost us the id printed
/// underneath it.
pub fn parse_ps_output(stdout: &str) -> ContainerInfo {
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(id) = parsed.get("ID").and_then(|id| id.as_str()) {
            return ContainerInfo {
                container_id: Some(id.to_string()),
                state: parsed
                    .get("State")
                    .and_then(|state| state.as_str())
                    .map(str::to_string),
            };
        }
    }
    ContainerInfo::default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn def(value: serde_json::Value) -> ServiceDef {
        serde_json::from_value(value).unwrap()
    }

    fn target(value: serde_json::Value) -> ComposeTarget {
        ComposeTarget::of(&def(value)).unwrap()
    }

    #[test]
    fn compose_argv_is_what_the_reference_runs() {
        let plain = target(json!({
            "name": "web",
            "kind": "docker-compose",
            "cwd": "/workspace",
            "composeService": "web",
        }));
        assert_eq!(plain.up_argv(), ["compose", "up", "-d", "web"]);
        assert_eq!(plain.stop_argv(), ["compose", "stop", "web"]);
        assert_eq!(
            plain.ps_argv(),
            ["compose", "ps", "--format", "json", "web"]
        );

        // A named compose file is a flag on every verb, not just the first.
        let filed = target(json!({
            "name": "web",
            "kind": "docker-compose",
            "cwd": "/workspace",
            "composeFile": "compose.yml",
            "composeService": "web",
        }));
        assert_eq!(
            filed.up_argv(),
            ["compose", "-f", "compose.yml", "up", "-d", "web"]
        );
        assert_eq!(
            filed.stop_argv(),
            ["compose", "-f", "compose.yml", "stop", "web"]
        );
    }

    #[test]
    fn a_target_without_both_halves_is_refused() {
        for missing in ["cwd", "composeService"] {
            let mut fields = serde_json::Map::new();
            fields.insert("name".into(), json!("web"));
            fields.insert("kind".into(), json!("docker-compose"));
            for (key, value) in [("cwd", "/workspace"), ("composeService", "web")] {
                if key != missing {
                    fields.insert(key.into(), json!(value));
                }
            }
            let error = ComposeTarget::of(&def(serde_json::Value::Object(fields.clone())))
                .unwrap_err()
                .to_string();
            assert_eq!(
                error,
                "Service \"web\" is missing docker-compose cwd or composeService."
            );

            // Blank is missing: acting on "" would act on the whole project.
            fields.insert(missing.into(), json!("  "));
            assert!(ComposeTarget::of(&def(serde_json::Value::Object(fields))).is_err());
        }
    }

    #[test]
    fn the_first_container_id_compose_prints_is_the_one_reported() {
        assert_eq!(
            parse_ps_output("{\"ID\":\"abc123\",\"State\":\"running\"}\n"),
            ContainerInfo {
                container_id: Some("abc123".into()),
                state: Some("running".into()),
            }
        );

        // A warning line ahead of the payload must not cost us the payload.
        assert_eq!(
            parse_ps_output("time=\"…\" level=warning msg=\"…\"\n{\"ID\":\"abc123\"}\n")
                .container_id,
            Some("abc123".into())
        );

        // Nothing running, nothing to report — not an error.
        assert_eq!(parse_ps_output(""), ContainerInfo::default());
        assert_eq!(
            parse_ps_output("{\"State\":\"exited\"}"),
            ContainerInfo::default()
        );
    }
}
