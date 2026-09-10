//! Agent identity is display metadata. A shell stays a shell for remote access
//! and prompt-insertion policy, even while an agent owns its foreground group.

use super::manager::{emit_terminal_session, TerminalManager};
use crate::event_sink::SharedEventSink;
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

struct Process {
    pid: u32,
    parent: u32,
    group: i32,
    command: String,
}

fn processes(raw: &str) -> Vec<Process> {
    raw.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some(Process {
                pid: fields.next()?.parse().ok()?,
                parent: fields.next()?.parse().ok()?,
                group: fields.next()?.parse().ok()?,
                command: fields.collect::<Vec<_>>().join(" "),
            })
        })
        .collect()
}

fn provider(command: &str) -> Option<&'static str> {
    let mut words = command.split_whitespace();
    let executable = Path::new(words.next()?).file_name()?.to_str()?;
    match executable {
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        "node" | "nodejs" | "bun" => {
            // Only the interpreter's script identifies an agent; a mention in
            // an argument to echo, a shell, or a different script never does.
            let script = words.next()?;
            if script.ends_with("/@anthropic-ai/claude-code/cli.js") {
                Some("claude")
            } else if script.ends_with("/@openai/codex/bin/codex.js") {
                Some("codex")
            } else {
                None
            }
        }
        _ => None,
    }
}

fn foreground_provider(rows: &[Process], root: u32, foreground: i32) -> Option<String> {
    let mut parents = HashSet::from([root]);
    let mut visited = HashSet::new();
    loop {
        let children: Vec<_> = rows
            .iter()
            .filter(|row| {
                !visited.contains(&row.pid) && (row.pid == root || parents.contains(&row.parent))
            })
            .collect();
        if children.is_empty() {
            return None;
        }
        for row in &children {
            if row.group == foreground {
                if let Some(provider) = provider(&row.command) {
                    return Some(provider.to_string());
                }
            }
        }
        parents.clear();
        for row in children {
            visited.insert(row.pid);
            parents.insert(row.pid);
        }
    }
}

impl TerminalManager {
    pub(super) fn watch_shell_agents(&self, sink: SharedEventSink) {
        {
            let mut locked = self.registry.0.lock().unwrap();
            if locked.detecting_agents {
                return;
            }
            locked.detecting_agents = true;
        }
        let registry = std::sync::Arc::downgrade(&self.registry);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(750));
            let Some(registry) = registry.upgrade() else {
                break;
            };
            let targets = {
                let mut locked = registry.0.lock().unwrap();
                let shells: Vec<_> = locked
                    .sessions
                    .values()
                    .filter(|session| {
                        session.metadata.kind.as_deref() == Some("shell")
                            && session.metadata.state == "running"
                    })
                    .collect();
                if shells.is_empty() || locked.shutting_down {
                    locked.detecting_agents = false;
                    break;
                }
                shells
                    .into_iter()
                    .filter_map(|session| {
                        session.pid.zip(session.master.process_group_leader()).map(
                            |(pid, group)| {
                                (
                                    session.metadata.id.clone(),
                                    session.generation.clone(),
                                    pid,
                                    group,
                                )
                            },
                        )
                    })
                    .collect::<Vec<_>>()
            };
            if targets.is_empty() {
                continue;
            }
            // One process-table read for every shell, rather than one child
            // process per tab per tick. No table reads when all shells close.
            let Ok(output) = std::process::Command::new("/bin/ps")
                .args(["-ax", "-o", "pid=,ppid=,pgid=,command="])
                .output()
            else {
                continue;
            };
            if !output.status.success() {
                continue;
            }
            let rows = processes(&String::from_utf8_lossy(&output.stdout));
            for (id, generation, root, group) in targets {
                let detected = foreground_provider(&rows, root, group);
                let snapshot = {
                    let mut locked = registry.0.lock().unwrap();
                    let Some(session) = locked.sessions.get_mut(&id) else {
                        continue;
                    };
                    if session.generation != generation || session.metadata.state != "running" {
                        continue;
                    }
                    // A foreground job can change during the process-table read.
                    if session.master.process_group_leader() != Some(group) {
                        continue;
                    }
                    if session.metadata.provider == detected {
                        continue;
                    }
                    session.metadata.provider = detected;
                    session.metadata.clone()
                };
                emit_terminal_session(sink.as_ref(), &snapshot);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_only_an_agent_in_this_shells_foreground_tree() {
        let rows = processes("10 1 10 /bin/zsh\n20 10 20 node /usr/lib/node_modules/@openai/codex/bin/codex.js\n30 10 30 claude\n40 1 40 codex");
        assert_eq!(foreground_provider(&rows, 10, 20).as_deref(), Some("codex"));
        assert_eq!(
            foreground_provider(&rows, 10, 30).as_deref(),
            Some("claude")
        );
        assert_eq!(foreground_provider(&rows, 10, 10), None);
        assert_eq!(foreground_provider(&rows, 10, 40), None);
    }

    #[test]
    fn recognizes_native_and_node_agents_without_matching_prompt_text() {
        assert_eq!(
            provider("/home/me/.local/bin/claude --resume"),
            Some("claude")
        );
        assert_eq!(
            provider("node /opt/node_modules/@anthropic-ai/claude-code/cli.js"),
            Some("claude")
        );
        assert_eq!(provider("/opt/codex --model test"), Some("codex"));
        for command in [
            "echo claude",
            "sh -c codex",
            "node server.js codex",
            "my-codex-wrapper",
            "node /tmp/codex.js",
        ] {
            assert_eq!(provider(command), None, "{command}");
        }
    }

    #[test]
    fn prefers_outer_agent_and_handles_cycles() {
        let rows =
            processes("10 1 10 zsh\n30 20 20 codex\n20 10 20 claude\n50 60 50 claude\n60 50 50 sh");
        assert_eq!(
            foreground_provider(&rows, 10, 20).as_deref(),
            Some("claude")
        );
        assert_eq!(foreground_provider(&rows, 10, 50), None);
    }
}
