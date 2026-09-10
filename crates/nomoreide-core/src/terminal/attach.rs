//! Local CLI discovery without publishing the desktop's HTTP credential.
//! The socket is private to the current OS user; each successful request issues
//! a separate, expiring one-use relay lease.

use super::{TerminalAttachment, TerminalManager, TerminalSpawnSpec};
use crate::event_sink::SharedEventSink;
use crate::external_terminal::{read_frame, write_frame, SocketPathGuard};
use serde::{Deserialize, Serialize};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

const REQUEST: u8 = 10;
const RESPONSE: u8 = 11;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachRequest {
    pub cwd: String,
    pub session_id: Option<String>,
    pub shell: Option<String>,
    pub path: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum AttachResponse {
    Attached { attachment: TerminalAttachment },
    Error { message: String },
}

pub fn socket_path(state_dir: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    use std::os::unix::ffi::OsStrExt;
    // sockaddr_un paths are short on macOS. Runtime paths (and test temp
    // directories) can be much longer, so use a stable digest under /tmp.
    let resolved = state_dir
        .canonicalize()
        .unwrap_or_else(|_| state_dir.to_path_buf());
    let digest = format!("{:x}", Sha256::digest(resolved.as_os_str().as_bytes()));
    PathBuf::from(format!("/tmp/nmi-attach-{}", unsafe { libc::geteuid() }))
        .join(format!("{}.sock", &digest[..32]))
}

pub struct AttachServer {
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Drop for AttachServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Called after the daemon acquires exclusive ownership of its runtime dir.
pub fn serve(
    state_dir: &Path,
    manager: TerminalManager,
    sink: SharedEventSink,
) -> Result<AttachServer, String> {
    let path = socket_path(state_dir);
    let directory = path.parent().expect("attach socket has a parent");
    use std::os::unix::fs::DirBuilderExt;
    match std::fs::DirBuilder::new().mode(0o700).create(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    let metadata = std::fs::symlink_metadata(directory).map_err(|error| error.to_string())?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err("Terminal attach directory is not private to this user".into());
    }
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("Refusing to replace an unowned terminal attach socket".into());
        }
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    let (listener, guard) = SocketPathGuard::bind(path).map_err(|error| error.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let worker = std::thread::spawn(move || {
        let _guard = guard;
        while !stopped.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    if !same_user(&stream) {
                        continue;
                    }
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                    let reply = match read_frame(&mut stream) {
                        Ok((REQUEST, bytes)) if bytes.len() <= 32 * 1024 => {
                            serde_json::from_slice::<AttachRequest>(&bytes)
                                .map_err(|error| error.to_string())
                                .and_then(|request| prepare(&manager, sink.clone(), request))
                        }
                        _ => Err("Invalid terminal attach request".to_string()),
                    };
                    let reply = match reply {
                        Ok(attachment) => AttachResponse::Attached { attachment },
                        Err(message) => AttachResponse::Error { message },
                    };
                    if let Ok(bytes) = serde_json::to_vec(&reply) {
                        let _ = write_frame(&mut stream, RESPONSE, &bytes);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(_) => break,
            }
        }
    });
    Ok(AttachServer {
        stop,
        worker: Some(worker),
    })
}

fn prepare(
    manager: &TerminalManager,
    sink: SharedEventSink,
    request: AttachRequest,
) -> Result<TerminalAttachment, String> {
    if let Some(id) = request.session_id {
        return manager.prepare_attachment(sink, &id);
    }
    let cwd = Path::new(&request.cwd);
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err("Attach requires an existing absolute working directory".into());
    }
    let id = format!("cli:{}", uuid::Uuid::new_v4());
    let mut spec = TerminalSpawnSpec::shell(id.clone(), request.cwd);
    if let Some(shell) = request.shell {
        if !Path::new(&shell).is_absolute() || !Path::new(&shell).is_file() {
            return Err("SHELL must name an existing absolute executable path".into());
        }
        spec.shell = shell.into();
    }
    if let Some(path) = request.path {
        spec.env.push(("PATH".into(), path));
    }
    // Lets nested attach invocations fail clearly rather than opening a shell
    // inside a shell indefinitely.
    spec.env
        .push(("NOMOREIDE_TERMINAL_SESSION".into(), id.clone()));
    manager.create(sink.clone(), spec)?;
    match manager.prepare_attachment(sink, &id) {
        Ok(attachment) => Ok(attachment),
        Err(error) => {
            let _ = manager.close_session(&id);
            Err(error)
        }
    }
}

pub fn request(state_dir: &Path, request: &AttachRequest) -> Result<TerminalAttachment, String> {
    let path = socket_path(state_dir);
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err("Terminal attach socket is not private to this user".into());
    }
    let mut stream = UnixStream::connect(path).map_err(|error| error.to_string())?;
    if !same_user(&stream) {
        return Err("Terminal attach server belongs to another user".into());
    }
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(request).map_err(|error| error.to_string())?;
    write_frame(&mut stream, REQUEST, &bytes).map_err(|error| error.to_string())?;
    let (kind, bytes) = read_frame(&mut stream).map_err(|error| error.to_string())?;
    if kind != RESPONSE {
        return Err("Invalid terminal attach response".into());
    }
    match serde_json::from_slice(&bytes).map_err(|error| error.to_string())? {
        AttachResponse::Attached { attachment } => Ok(attachment),
        AttachResponse::Error { message } => Err(message),
    }
}

fn same_user(stream: &UnixStream) -> bool {
    use std::os::fd::AsRawFd;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut credentials as *mut _ as *mut libc::c_void,
                &mut length,
            ) == 0
                && credentials.uid == libc::geteuid()
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        let mut uid = 0;
        let mut gid = 0;
        unsafe {
            libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) == 0 && uid == libc::geteuid()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_sink::{EventSink, EventSinkError};
    use crate::external_terminal::{ATTACHED, AUTH, INPUT, RESIZE};
    use crate::terminal::TerminalPresentation;
    use std::time::Instant;

    struct Silent;
    impl EventSink for Silent {
        fn emit(&self, _: &str, _: serde_json::Value) -> Result<(), EventSinkError> {
            Ok(())
        }
    }

    fn wait_for(mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !condition() {
            assert!(Instant::now() < deadline, "terminal state did not settle");
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[test]
    fn cli_shell_relay_detects_agents_and_hands_back_the_same_session() {
        let dir = PathBuf::from(format!("/tmp/nmi-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&dir).unwrap();
        let manager = TerminalManager::new();
        let sink: SharedEventSink = Arc::new(Silent);
        let server = serve(&dir, manager.clone(), sink.clone()).unwrap();
        let command = AttachRequest {
            cwd: dir.to_string_lossy().into_owned(),
            session_id: None,
            shell: Some("/bin/sh".into()),
            path: None,
        };
        let attached = request(&dir, &command).unwrap();
        let id = &attached.session.id;
        assert_eq!(attached.session.cwd, command.cwd);
        assert_eq!(attached.session.kind.as_deref(), Some("shell"));
        let mut relay = UnixStream::connect(&attached.socket_path).unwrap();
        relay
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write_frame(&mut relay, AUTH, attached.token.as_bytes()).unwrap();
        assert_eq!(read_frame(&mut relay).unwrap().0, ATTACHED);
        wait_for(|| manager.list_sessions()[0].presentation == TerminalPresentation::Terminal);
        assert!(manager.write_input(id, b"echo forbidden\n").is_err());
        write_frame(&mut relay, RESIZE, &[0, 110, 0, 35]).unwrap();
        wait_for(|| manager.session_size(id) == Some((110, 35)));

        // Exercise both real native executable names through a real shell and
        // foreground PTY group, without invoking a paid agent or network call.
        for provider in ["claude", "codex"] {
            let executable = dir.join(provider);
            std::os::unix::fs::symlink("/bin/sleep", &executable).unwrap();
            write_frame(
                &mut relay,
                INPUT,
                format!("{} 3\n", executable.display()).as_bytes(),
            )
            .unwrap();
            wait_for(|| manager.list_sessions()[0].provider.as_deref() == Some(provider));
            assert!(
                !manager.is_mirrorable(id, false),
                "detection must not grant remote shell access"
            );
            assert!(manager.insert_agent_prompt(id, "hello").is_err());
            wait_for(|| manager.list_sessions()[0].provider.is_none());
        }
        let reclaimed = manager.reclaim_to_dock(sink.as_ref(), id).unwrap();
        assert_eq!(reclaimed.id, *id);
        assert_eq!(reclaimed.state, "running");
        assert_eq!(reclaimed.presentation, TerminalPresentation::Dock);
        manager
            .write_input(id, b"printf 'handoff-ok\\n'\n")
            .unwrap();
        wait_for(|| {
            String::from_utf8_lossy(&manager.attach_output(id).unwrap()).contains("handoff-ok")
        });
        let reconnect = request(
            &dir,
            &AttachRequest {
                session_id: Some(id.clone()),
                ..command
            },
        )
        .unwrap();
        assert_eq!(reconnect.session.id, *id);
        assert_eq!(manager.list_sessions().len(), 1);
        manager.reclaim_to_dock(sink.as_ref(), id).unwrap();
        manager.close_all().unwrap();
        drop(server);
        assert!(!socket_path(&dir).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_invalid_cwd_and_unknown_sessions_without_spawning() {
        let manager = TerminalManager::new();
        let sink: SharedEventSink = Arc::new(Silent);
        for session_id in [None, Some("missing".into())] {
            assert!(prepare(
                &manager,
                sink.clone(),
                AttachRequest {
                    cwd: "relative".into(),
                    session_id,
                    shell: None,
                    path: None,
                }
            )
            .is_err());
            assert!(manager.list_sessions().is_empty());
        }
    }
}
