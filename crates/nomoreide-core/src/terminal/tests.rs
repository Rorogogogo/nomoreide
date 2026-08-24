//! The manager's own behaviour, exercised against real PTYs.
//!
//! These spawn actual shells: the lifecycle rules being checked here — that a
//! stale generation cannot publish state, that a close reaps descendants, that
//! a lease scopes an external presentation — are exactly the ones a mock would
//! have to assume rather than prove.

use super::agent::{derive_agent_invocation, resolve_session_scope};
use super::manager::{IdReservation, OutputGate, PtySession, TerminalManager};
use super::session::{
    configure_interactive_terminal_environment, encode_agent_prompt_paste, normalize_agent_label,
    normalize_session_label, validate_agent_prompt_target, TerminalPresentation, TerminalSession,
};

#[test]
fn agent_prompt_paste_is_unsubmitted_and_rejects_terminal_controls() {
    assert_eq!(
        encode_agent_prompt_paste("Review this\r\nwithout submitting").unwrap(),
        "\u{1b}[200~Review this\rwithout submitting\u{1b}[201~"
    );
    assert!(encode_agent_prompt_paste("").is_err());
    assert!(encode_agent_prompt_paste("submit\r").is_err());
    assert!(encode_agent_prompt_paste("escape\u{1b}").is_err());
}

#[test]
fn agent_prompt_target_allows_dock_and_terminal_but_not_launching() {
    let mut session = TerminalSession {
        id: "agent".to_string(),
        service_name: None,
        cwd: "/tmp".to_string(),
        cols: 120,
        rows: 40,
        shell: "codex".to_string(),
        state: "running".to_string(),
        label: None,
        kind: Some("agent".to_string()),
        provider: Some("codex".to_string()),
        presentation: TerminalPresentation::Dock,
    };
    assert!(validate_agent_prompt_target(&session).is_ok());
    session.presentation = TerminalPresentation::Terminal;
    assert!(validate_agent_prompt_target(&session).is_ok());
    session.presentation = TerminalPresentation::TerminalLaunching;
    assert!(validate_agent_prompt_target(&session).is_err());
    session.presentation = TerminalPresentation::Dock;
    session.kind = Some("shell".to_string());
    assert!(validate_agent_prompt_target(&session).is_err());
    session.kind = Some("agent".to_string());
    session.state = "exited".to_string();
    assert!(validate_agent_prompt_target(&session).is_err());
}

#[cfg(unix)]
#[test]
fn manager_inserts_prompt_without_changing_session_ownership_or_size() {
    let manager = TerminalManager::new();
    spawn_test_session(&manager, "agent-prompt", "read line");
    {
        let mut registry = manager.registry.0.lock().unwrap();
        let session = registry.sessions.get_mut("agent-prompt").unwrap();
        session.metadata.kind = Some("agent".to_string());
        session.metadata.provider = Some("codex".to_string());
        session.metadata.presentation = TerminalPresentation::Terminal;
    }

    let inserted = manager
        .insert_agent_prompt("agent-prompt", "Review this\nwithout submitting")
        .unwrap();

    assert_eq!(inserted.presentation, TerminalPresentation::Terminal);
    assert_eq!((inserted.cols, inserted.rows), (80, 24));
    std::thread::sleep(std::time::Duration::from_millis(100));
}

#[cfg(unix)]
#[test]
fn unix_shell_resolution_uses_shell_then_bin_sh() {
    use super::agent::default_terminal_shell_from;
    use std::ffi::{OsStr, OsString};

    assert_eq!(
        default_terminal_shell_from(Some(OsString::from("/custom/shell"))),
        OsStr::new("/custom/shell")
    );
    assert_eq!(default_terminal_shell_from(None), OsStr::new("/bin/sh"));
}

#[cfg(windows)]
#[test]
fn windows_shell_resolution_uses_comspec_then_cmd_and_preserves_path() {
    use super::agent::default_terminal_shell_from;
    use std::ffi::{OsStr, OsString};

    assert_eq!(
        default_terminal_shell_from(Some(OsString::from("custom-cmd.exe"))),
        OsStr::new("custom-cmd.exe")
    );
    assert_eq!(default_terminal_shell_from(None), OsStr::new("cmd.exe"));
    assert!(super::agent::agent_path_override().is_none());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_agent_path_is_enriched() {
    assert!(super::agent::agent_path_override().is_some());
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn non_macos_agent_path_preserves_inherited_environment() {
    assert!(super::agent::agent_path_override().is_none());
}

#[test]
fn interactive_terminal_enables_color_when_the_parent_suppresses_it() {
    let mut command = portable_pty::CommandBuilder::new("shell");
    command.env("NO_COLOR", "1");

    configure_interactive_terminal_environment(&mut command, None);

    assert!(command.get_env("NO_COLOR").is_none());
    assert_eq!(
        command.get_env("TERM"),
        Some(std::ffi::OsStr::new("xterm-256color"))
    );
    assert_eq!(
        command.get_env("COLORTERM"),
        Some(std::ffi::OsStr::new("truecolor"))
    );
}

#[test]
fn embedded_codex_uses_palette_driven_ansi_colors() {
    let mut command = portable_pty::CommandBuilder::new("codex");
    command.env("FORCE_COLOR", "3");

    configure_interactive_terminal_environment(&mut command, Some("codex"));

    assert_eq!(
        command.get_env("FORCE_COLOR"),
        Some(std::ffi::OsStr::new("1"))
    );
}

#[cfg(unix)]
fn spawn_test_session(manager: &TerminalManager, id: &str, script: &str) -> u32 {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::sync::{Arc, Mutex};

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", script]);
    let child = pair.slave.spawn_command(command).unwrap();
    let pid = child.process_id().unwrap();
    let generation = uuid::Uuid::new_v4().to_string();
    let killer = child.clone_killer();
    let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
    let session = PtySession {
        control: Arc::new(Mutex::new(())),
        prompt_write_active: false,
        generation: generation.clone(),
        pid: Some(pid),
        group_cleanup_complete: false,
        metadata: TerminalSession {
            id: id.to_string(),
            service_name: None,
            cwd: "/tmp".to_string(),
            cols: 80,
            rows: 24,
            shell: "/bin/sh".to_string(),
            state: "running".to_string(),
            label: None,
            kind: Some("shell".to_string()),
            provider: None,
            presentation: TerminalPresentation::Dock,
        },
        writer,
        killer,
        master: pair.master,
        gate: Arc::new(Mutex::new(OutputGate::default())),
        #[cfg(target_os = "macos")]
        attachment: None,
    };
    manager
        .registry
        .0
        .lock()
        .unwrap()
        .insert(id.to_string(), session);
    manager.start_child_waiter(id.to_string(), generation, child);
    pid
}

#[cfg(target_os = "macos")]
#[test]
fn external_presentation_transitions_are_lease_scoped_and_idempotent() {
    use std::io::Read;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::sync::mpsc::sync_channel;
    use std::sync::Arc;

    let manager = TerminalManager::new();
    spawn_test_session(&manager, "external-transition", "sleep 30");
    let path = crate::external_terminal::new_socket_path();
    let _listener = UnixListener::bind(&path).unwrap();
    let (revoke, mut peer) = UnixStream::pair().unwrap();
    peer.set_read_timeout(Some(std::time::Duration::from_millis(100)))
        .unwrap();
    let (sender, _receiver) = sync_channel(1);
    {
        let mut registry = manager.registry.0.lock().unwrap();
        let session = registry.sessions.get_mut("external-transition").unwrap();
        session.metadata.kind = Some("agent".to_string());
        session.metadata.presentation = TerminalPresentation::Terminal;
        session.attachment = Some(super::external::ExternalAttachment {
            lease: "current".to_string(),
            socket_path: path.clone(),
            revoke: Some(revoke.try_clone().unwrap()),
        });
        session.gate.lock().unwrap().external = Some(super::external::ExternalOutputSink {
            lease: "current".to_string(),
            sender,
            revoke: Arc::new(revoke),
        });

        assert!(!super::external::revoke_external_attachment(
            session,
            Some("stale")
        ));
        assert_eq!(
            session.metadata.presentation,
            TerminalPresentation::Terminal
        );
        assert!(super::external::revoke_external_attachment(
            session,
            Some("current")
        ));
        assert_eq!(session.metadata.presentation, TerminalPresentation::Dock);
        assert!(!super::external::revoke_external_attachment(
            session,
            Some("current")
        ));
    }

    let mut byte = [0u8; 1];
    assert_eq!(peer.read(&mut byte).unwrap(), 0);
    assert!(!path.exists());
    manager.close_session("external-transition").unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn output_overflow_and_disconnect_revoke_the_external_sink() {
    use std::os::unix::net::UnixStream;
    use std::sync::mpsc::sync_channel;
    use std::sync::Arc;

    for disconnected in [false, true] {
        let (revoke, _peer) = UnixStream::pair().unwrap();
        let (sender, receiver) = sync_channel(1);
        if disconnected {
            drop(receiver);
        } else {
            sender
                .send(super::external::ExternalOutput::Replay(Vec::new()))
                .unwrap();
        }
        let mut gate = OutputGate {
            external: Some(super::external::ExternalOutputSink {
                lease: "overflow".to_string(),
                sender,
                revoke: Arc::new(revoke),
            }),
            ..OutputGate::default()
        };

        assert_eq!(
            super::external::forward_external_output(&mut gate, b"next"),
            Some("overflow".to_string())
        );
        assert!(gate.external.is_none());
    }
}

#[cfg(target_os = "macos")]
#[test]
fn closed_output_gate_rejects_a_new_external_launch() {
    let manager = TerminalManager::new();
    spawn_test_session(&manager, "closed-launch", "sleep 30");
    {
        let mut registry = manager.registry.0.lock().unwrap();
        let session = registry.sessions.get_mut("closed-launch").unwrap();
        session.metadata.kind = Some("agent".to_string());
        session.gate.lock().unwrap().closed = true;
        assert_eq!(
            super::external::validate_external_launch(session).unwrap_err(),
            "Only a running agent session can open in Terminal",
        );
    }
    manager.close_session("closed-launch").unwrap();
}

#[cfg(unix)]
#[test]
fn natural_child_exit_is_reaped_and_reported_as_exited() {
    let manager = TerminalManager::new();
    let pid = spawn_test_session(&manager, "natural", "exit 0");

    for _ in 0..100 {
        let state = manager
            .list_sessions()
            .into_iter()
            .find(|session| session.id == "natural")
            .unwrap()
            .state;
        if state == "exited" {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    let session = manager
        .list_sessions()
        .into_iter()
        .find(|session| session.id == "natural")
        .unwrap();
    assert_eq!(session.state, "exited");
    assert!(!process_exists(pid));
    manager.close_session("natural").unwrap();
    assert!(manager.list_sessions().is_empty());
}

#[cfg(unix)]
#[test]
fn stale_waiter_generation_cannot_mark_a_replacement_exited() {
    let manager = TerminalManager::new();
    spawn_test_session(&manager, "replacement", "sleep 30");

    manager.mark_child_state("replacement", "old-generation", "exited");

    let session = manager
        .list_sessions()
        .into_iter()
        .find(|session| session.id == "replacement")
        .unwrap();
    assert_eq!(session.state, "running");
    manager.close_session("replacement").unwrap();
}

#[test]
fn stable_id_reservation_allows_only_one_concurrent_creator() {
    use std::sync::{Arc, Barrier};

    let manager = Arc::new(TerminalManager::new());
    let barrier = Arc::new(Barrier::new(3));
    let mut threads = Vec::new();
    for _ in 0..2 {
        let manager = manager.clone();
        let barrier = barrier.clone();
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            manager.reserve_id("svc:api")
        }));
    }
    barrier.wait();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();

    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Ok(IdReservation::Reserved)))
            .count(),
        1
    );
    assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
}

#[test]
fn close_during_reserved_creation_returns_an_error() {
    let manager = TerminalManager::new();
    assert!(matches!(
        manager.reserve_id("svc:api"),
        Ok(IdReservation::Reserved)
    ));

    let error = manager.close_session("svc:api").unwrap_err();

    assert!(error.contains("creation"));
    assert!(manager.reserve_id("svc:api").is_err());
    manager.release_reservation("svc:api");
}

#[cfg(unix)]
#[test]
fn closing_a_session_terminates_and_reaps_a_long_running_child() {
    let manager = TerminalManager::new();
    let pid = spawn_test_session(&manager, "long-running", "sleep 30");
    assert!(process_exists(pid));

    manager.close_session("long-running").unwrap();

    for _ in 0..100 {
        if !process_exists(pid) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(!process_exists(pid));
    assert!(manager.list_sessions().is_empty());
}

#[cfg(unix)]
#[test]
fn close_kills_sighup_resistant_child_and_descendant_process_group() {
    let manager = TerminalManager::new();
    let descendant_file = std::env::temp_dir().join(format!(
        "nomoreide-terminal-descendant-{}",
        uuid::Uuid::new_v4()
    ));
    let script = format!(
        "trap '' HUP; /bin/sh -c 'trap \"\" HUP; echo $$ > {}; exec sleep 30' & wait",
        descendant_file.to_string_lossy()
    );
    let parent_pid = spawn_test_session(&manager, "process-group", &script);
    let descendant_pid = (0..100)
        .find_map(|_| {
            let pid = std::fs::read_to_string(&descendant_file)
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok());
            if pid.is_none() {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            pid
        })
        .expect("descendant pid should be written");
    assert!(process_exists(parent_pid));
    assert!(process_exists(descendant_pid));

    manager.close_session("process-group").unwrap();

    assert!(!process_exists(parent_pid));
    assert!(!process_exists(descendant_pid));
    let _ = std::fs::remove_file(descendant_file);
}

#[cfg(unix)]
#[test]
fn reserve_is_blocked_and_second_close_is_idempotent_while_closing() {
    use std::sync::Arc;

    let manager = Arc::new(TerminalManager::new());
    spawn_test_session(&manager, "svc:closing", "trap '' HUP; exec sleep 30");
    std::thread::sleep(std::time::Duration::from_millis(50));
    let closer = {
        let manager = manager.clone();
        std::thread::spawn(move || manager.close_session("svc:closing"))
    };
    for _ in 0..100 {
        if manager
            .registry
            .0
            .lock()
            .unwrap()
            .closing
            .contains_key("svc:closing")
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }

    let reserve_error = manager.reserve_id("svc:closing").unwrap_err();
    assert!(reserve_error.contains("closing"));
    assert!(manager.close_session("svc:closing").is_ok());
    assert!(closer.join().unwrap().is_ok());
    assert!(manager.list_sessions().is_empty());
}

#[cfg(unix)]
#[test]
fn close_all_kills_and_reaps_every_session_and_descendant() {
    let manager = TerminalManager::new();
    let descendant_file = std::env::temp_dir().join(format!(
        "nomoreide-terminal-close-all-descendant-{}",
        uuid::Uuid::new_v4()
    ));
    let resistant_script = format!(
        "trap '' HUP; /bin/sh -c 'trap \"\" HUP; echo $$ > {}; exec sleep 30' & wait",
        descendant_file.to_string_lossy()
    );
    let resistant_pid = spawn_test_session(&manager, "resistant", &resistant_script);
    let ordinary_pid = spawn_test_session(&manager, "ordinary", "sleep 30");
    let descendant_pid = (0..100)
        .find_map(|_| {
            let pid = std::fs::read_to_string(&descendant_file)
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok());
            if pid.is_none() {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            pid
        })
        .expect("descendant pid should be written");

    manager.close_all().unwrap();

    assert!(!process_exists(resistant_pid));
    assert!(!process_exists(ordinary_pid));
    assert!(!process_exists(descendant_pid));
    assert!(manager.list_sessions().is_empty());
    let _ = std::fs::remove_file(descendant_file);
}

#[cfg(unix)]
#[test]
fn waiter_cleans_live_descendant_before_reporting_leader_exited() {
    let manager = TerminalManager::new();
    let descendant_file = std::env::temp_dir().join(format!(
        "nomoreide-terminal-exited-leader-descendant-{}",
        uuid::Uuid::new_v4()
    ));
    let script = format!(
        "/bin/sh -c 'trap \"\" HUP; echo $$ > {}; exec sleep 30' & while [ ! -s {} ]; do sleep 0.01; done; exit 0",
        descendant_file.to_string_lossy(),
        descendant_file.to_string_lossy()
    );
    let leader_pid = spawn_test_session(&manager, "exited-leader", &script);
    let descendant_pid = (0..100)
        .find_map(|_| {
            let pid = std::fs::read_to_string(&descendant_file)
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok());
            if pid.is_none() {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            pid
        })
        .expect("descendant pid should be written");
    for _ in 0..100 {
        let exited = manager
            .list_sessions()
            .into_iter()
            .find(|session| session.id == "exited-leader")
            .map(|session| session.state == "exited")
            .unwrap_or(false);
        if exited {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let session = manager
        .list_sessions()
        .into_iter()
        .find(|session| session.id == "exited-leader")
        .unwrap();
    assert_eq!(session.state, "exited");
    assert!(!process_exists(leader_pid));
    assert!(!process_exists(descendant_pid));
    std::thread::sleep(std::time::Duration::from_millis(50));

    assert!(manager.close_session("exited-leader").is_ok());
    assert!(manager.list_sessions().is_empty());
    let _ = std::fs::remove_file(descendant_file);
}

#[cfg(unix)]
#[test]
fn close_removes_cleanup_complete_session_without_touching_stored_pid() {
    let manager = TerminalManager::new();
    spawn_test_session(&manager, "stale-pid", "sleep 30");
    let mut test_killer = {
        let mut registry = manager.registry.0.lock().unwrap();
        let session = registry.sessions.get_mut("stale-pid").unwrap();
        let killer = session.killer.clone_killer();
        session.pid = Some(u32::MAX);
        session.metadata.state = "exited".to_string();
        session.group_cleanup_complete = true;
        killer
    };

    assert!(manager.close_session("stale-pid").is_ok());
    assert!(manager.list_sessions().is_empty());

    // The deliberately invalid stored PID above must never be inspected or
    // signaled. Clean up through the retained direct-child handle instead.
    let _ = test_killer.kill();
}

#[cfg(unix)]
#[test]
fn non_running_session_without_confirmed_group_cleanup_is_retained_without_signaling() {
    let manager = TerminalManager::new();
    let pid = spawn_test_session(&manager, "unsafe-terminal", "sleep 30");
    {
        let mut registry = manager.registry.0.lock().unwrap();
        let session = registry.sessions.get_mut("unsafe-terminal").unwrap();
        session.metadata.state = "error".to_string();
        session.group_cleanup_complete = false;
    }

    let error = manager.close_session("unsafe-terminal").unwrap_err();

    assert!(error.contains("cleanup"));
    assert!(process_exists(pid));
    assert!(manager
        .list_sessions()
        .iter()
        .any(|session| session.id == "unsafe-terminal"));
    {
        let mut registry = manager.registry.0.lock().unwrap();
        registry
            .sessions
            .get_mut("unsafe-terminal")
            .unwrap()
            .metadata
            .state = "running".to_string();
    }
    manager.close_session("unsafe-terminal").unwrap();
}

#[cfg(unix)]
#[test]
fn close_all_waits_for_an_active_close_to_finish() {
    use std::sync::{mpsc, Arc};

    let manager = Arc::new(TerminalManager::new());
    let pid = spawn_test_session(&manager, "active-close", "trap '' HUP; exec sleep 30");
    std::thread::sleep(std::time::Duration::from_millis(50));
    let closer = {
        let manager = manager.clone();
        std::thread::spawn(move || manager.close_session("active-close"))
    };
    for _ in 0..100 {
        if manager
            .registry
            .0
            .lock()
            .unwrap()
            .closing
            .contains_key("active-close")
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let (tx, rx) = mpsc::channel();
    let shutdown = {
        let manager = manager.clone();
        std::thread::spawn(move || tx.send(manager.close_all()).unwrap())
    };

    assert!(rx
        .recv_timeout(std::time::Duration::from_millis(50))
        .is_err());
    assert!(closer.join().unwrap().is_ok());
    assert!(rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap()
        .is_ok());
    shutdown.join().unwrap();
    assert!(!process_exists(pid));
    assert!(manager.list_sessions().is_empty());
}

#[test]
fn close_all_waits_for_reservations_and_fences_future_creation() {
    use std::sync::{mpsc, Arc};

    let manager = Arc::new(TerminalManager::new());
    assert!(matches!(
        manager.reserve_id("svc:reserved"),
        Ok(IdReservation::Reserved)
    ));
    let (tx, rx) = mpsc::channel();
    let shutdown = {
        let manager = manager.clone();
        std::thread::spawn(move || tx.send(manager.close_all()).unwrap())
    };

    assert!(rx
        .recv_timeout(std::time::Duration::from_millis(50))
        .is_err());
    manager.release_reservation("svc:reserved");
    assert!(rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap()
        .is_ok());
    shutdown.join().unwrap();
    let error = manager.reserve_id("svc:later").unwrap_err();
    assert!(error.contains("shutting down"));
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[test]
fn agent_scope_ignores_browser_service_and_cwd_in_favor_of_workspace() {
    let scope = resolve_session_scope(
        true,
        Some("browser-service".to_string()),
        Some("/browser/cwd".to_string()),
        Some("/configured/service".to_string()),
        Some("/workspace/repository".to_string()),
        "/current/dir".to_string(),
    );

    assert_eq!(scope.service_name, None);
    assert_eq!(scope.work_dir, "/workspace/repository");
}

#[test]
fn agent_scope_falls_back_to_current_dir_without_a_workspace_repository() {
    let scope = resolve_session_scope(
        true,
        Some("browser-service".to_string()),
        Some("/browser/cwd".to_string()),
        Some("/configured/service".to_string()),
        None,
        "/current/dir".to_string(),
    );

    assert_eq!(scope.service_name, None);
    assert_eq!(scope.work_dir, "/current/dir");
}

#[test]
fn non_agent_scope_preserves_plain_and_service_precedence() {
    let requested = resolve_session_scope(
        false,
        Some("api".to_string()),
        Some("/requested/cwd".to_string()),
        Some("/configured/service".to_string()),
        Some("/workspace/repository".to_string()),
        "/current/dir".to_string(),
    );
    let configured = resolve_session_scope(
        false,
        Some("api".to_string()),
        None,
        Some("/configured/service".to_string()),
        Some("/workspace/repository".to_string()),
        "/current/dir".to_string(),
    );

    assert_eq!(requested.service_name.as_deref(), Some("api"));
    assert_eq!(requested.work_dir, "/requested/cwd");
    assert_eq!(configured.service_name.as_deref(), Some("api"));
    assert_eq!(configured.work_dir, "/configured/service");
}

#[test]
fn claude_invocation_passes_the_prompt_as_a_positional_argument() {
    let prompt = "  inspect this project\nthen explain it  ";

    let invocation =
        derive_agent_invocation("claude", prompt, None, None, "claude", "codex").unwrap();

    assert_eq!(invocation.executable, "claude");
    assert_eq!(invocation.args, vec![prompt]);
}

#[test]
fn codex_invocation_disables_alt_screen_and_passes_the_prompt() {
    let prompt = "  inspect this project\nthen explain it  ";

    let invocation =
        derive_agent_invocation("codex", prompt, None, None, "claude", "codex").unwrap();

    assert_eq!(invocation.executable, "codex");
    assert_eq!(invocation.args, vec!["--no-alt-screen", prompt]);
}

#[test]
fn blank_agent_prompt_opens_an_interactive_session() {
    let claude =
        derive_agent_invocation("claude", " \n\t ", None, None, "claude", "codex").unwrap();
    let codex = derive_agent_invocation("codex", "", None, None, "claude", "codex").unwrap();

    assert!(claude.args.is_empty());
    assert_eq!(codex.args, vec!["--no-alt-screen"]);
}

#[test]
fn unknown_agent_provider_is_rejected() {
    let error =
        derive_agent_invocation("other", "do work", None, None, "claude", "codex").unwrap_err();

    assert_eq!(error, "Unsupported agent provider: other");
}

#[test]
fn agent_invocation_uses_resolved_executable_overrides() {
    let claude = derive_agent_invocation(
        "claude",
        "do work",
        None,
        None,
        "/custom/bin/claude",
        "/custom/bin/codex",
    )
    .unwrap();
    let codex = derive_agent_invocation(
        "codex",
        "do work",
        None,
        None,
        "/custom/bin/claude",
        "/custom/bin/codex",
    )
    .unwrap();

    assert_eq!(claude.executable, "/custom/bin/claude");
    assert_eq!(codex.executable, "/custom/bin/codex");
}

#[test]
fn agent_invocation_resumes_provider_sessions_without_a_prompt() {
    let id = "dce2b69c-0fb4-4bd3-b456-b2bef4230c81";
    let claude = derive_agent_invocation("claude", "", Some(id), None, "claude", "codex").unwrap();
    let codex = derive_agent_invocation("codex", "", Some(id), None, "claude", "codex").unwrap();

    assert_eq!(claude.args, vec!["--resume", id]);
    assert_eq!(codex.args, vec!["--no-alt-screen", "resume", id]);
}

#[test]
fn agent_label_is_trimmed_and_capped_at_sixty_characters() {
    let requested = format!("  {}  ", "A".repeat(70));

    assert_eq!(
        normalize_agent_label("codex", Some(&requested)),
        "A".repeat(60)
    );
}

#[test]
fn agent_label_uses_provider_default_when_missing_or_blank() {
    assert_eq!(normalize_agent_label("claude", None), "Claude task");
    assert_eq!(normalize_agent_label("codex", Some(" \t ")), "Codex task");
}

#[test]
fn session_rename_requires_a_trimmed_label_within_sixty_characters() {
    assert_eq!(
        normalize_session_label("  Build watcher  ").unwrap(),
        "Build watcher"
    );
    assert!(normalize_session_label(" \t ").is_err());
    assert!(normalize_session_label(&"A".repeat(61)).is_err());
    assert!(normalize_session_label(&"😀".repeat(30)).is_ok());
    assert!(normalize_session_label(&"😀".repeat(31)).is_err());
}

#[test]
fn session_rename_rejects_closing_and_shutting_down_managers() {
    let manager = TerminalManager::new();
    {
        let mut registry = manager.registry.0.lock().unwrap();
        registry
            .closing
            .insert("term_closing".to_string(), "generation".to_string());
    }
    assert!(manager
        .rename_session("term_closing", "Renamed".to_string())
        .unwrap_err()
        .contains("closing"));

    {
        let mut registry = manager.registry.0.lock().unwrap();
        registry.closing.clear();
        registry.shutting_down = true;
    }
    assert!(manager
        .rename_session("term_missing", "Renamed".to_string())
        .unwrap_err()
        .contains("shutting down"));
}

#[cfg(unix)]
#[test]
fn sessions_are_listed_oldest_first_and_a_close_does_not_reshuffle_the_rest() {
    let manager = TerminalManager::new();
    for id in ["zz-last", "aa-first", "mm-middle"] {
        spawn_test_session(&manager, id, "sleep 30");
    }

    let listed: Vec<String> = manager
        .list_sessions()
        .into_iter()
        .map(|session| session.id)
        .collect();
    assert_eq!(listed, ["zz-last", "aa-first", "mm-middle"]);

    manager.close_session("aa-first").unwrap();
    let remaining: Vec<String> = manager
        .list_sessions()
        .into_iter()
        .map(|session| session.id)
        .collect();
    assert_eq!(remaining, ["zz-last", "mm-middle"]);
    manager.close_all().unwrap();
}
