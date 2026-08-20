#[cfg(target_os = "macos")]
mod macos {
    use std::env;
    use std::fs;
    use std::io::{self, Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{Duration, Instant};

    pub const AUTH: u8 = 1;
    pub const INPUT: u8 = 2;
    pub const RESIZE: u8 = 3;
    pub const DETACH: u8 = 4;
    pub const OUTPUT: u8 = 101;
    pub const ATTACHED: u8 = 102;
    pub const REVOKED: u8 = 103;
    pub const ERROR: u8 = 104;
    pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

    pub struct SocketPathGuard {
        path: PathBuf,
    }

    pub fn new_socket_path() -> PathBuf {
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        PathBuf::from("/tmp").join(format!(
            "nmi-{:x}-{}.sock",
            std::process::id(),
            &nonce[..16],
        ))
    }

    impl SocketPathGuard {
        pub fn bind(path: PathBuf) -> io::Result<(UnixListener, Self)> {
            let listener = UnixListener::bind(&path)?;
            let guard = Self { path };
            fs::set_permissions(&guard.path, fs::Permissions::from_mode(0o600))?;
            listener.set_nonblocking(true)?;
            Ok((listener, guard))
        }
    }

    impl Drop for SocketPathGuard {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    pub fn write_frame(writer: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
        if payload.len() > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "terminal frame is too large",
            ));
        }
        writer.write_all(&[kind])?;
        writer.write_all(&(payload.len() as u32).to_be_bytes())?;
        writer.write_all(payload)?;
        writer.flush()
    }

    pub fn read_frame(reader: &mut impl Read) -> io::Result<(u8, Vec<u8>)> {
        let mut header = [0u8; 5];
        reader.read_exact(&mut header)?;
        let length = u32::from_be_bytes(header[1..5].try_into().unwrap()) as usize;
        if length > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "terminal frame is too large",
            ));
        }
        let mut payload = vec![0; length];
        reader.read_exact(&mut payload)?;
        Ok((header[0], payload))
    }

    pub fn accept_authenticated(
        listener: &UnixListener,
        token: &[u8],
        deadline: Instant,
        auth_timeout: Duration,
        mut keep_waiting: impl FnMut() -> bool,
    ) -> io::Result<Option<UnixStream>> {
        while Instant::now() < deadline && keep_waiting() {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let candidate_timeout = auth_timeout.min(remaining);
                    if candidate_timeout.is_zero() {
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                        return Ok(None);
                    }
                    stream.set_read_timeout(Some(candidate_timeout))?;
                    let authenticated = matches!(
                        read_frame(&mut stream),
                        Ok((AUTH, payload)) if payload == token
                    );
                    if authenticated {
                        stream.set_read_timeout(None)?;
                        return Ok(Some(stream));
                    }
                    let _ = write_frame(
                        &mut stream,
                        ERROR,
                        b"Terminal attachment authentication failed",
                    );
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error),
            }
        }
        Ok(None)
    }

    pub fn posix_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    pub fn external_terminal_title(provider: Option<&str>, label: Option<&str>) -> String {
        let (marker, provider_label, fallback) = match provider {
            Some("codex") => ("🟢", "CODEX", "Codex task"),
            Some("claude") => ("🟠", "CLAUDE", "Claude task"),
            _ => ("🔵", "AGENT", "Agent task"),
        };
        let sanitized = label
            .unwrap_or_default()
            .chars()
            .map(|character| {
                if character.is_control() {
                    ' '
                } else {
                    character
                }
            })
            .collect::<String>();
        let task_label = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
        let task_label = if task_label.is_empty() {
            fallback.to_string()
        } else {
            task_label
        };
        format!("{marker} {provider_label} · {task_label} · NoMoreIDE")
    }

    pub fn launch_terminal(socket_path: &Path, token: &str, title: &str) -> Result<(), String> {
        let executable = env::current_exe().map_err(|error| error.to_string())?;
        let executable = executable
            .to_str()
            .ok_or_else(|| "NoMoreIDE executable path is not valid UTF-8".to_string())?;
        let socket_path = socket_path
            .to_str()
            .ok_or_else(|| "Terminal attachment path is not valid UTF-8".to_string())?;
        let command = format!(
            "exec {} --terminal-attach {} {}",
            posix_quote(executable),
            posix_quote(socket_path),
            posix_quote(token),
        );
        let script = "on run argv\n  tell application \"Terminal\"\n    set newTab to do script (item 1 of argv)\n    set custom title of newTab to (item 2 of argv)\n    activate\n  end tell\nend run";
        let status = Command::new("/usr/bin/osascript")
            .args(["-e", script, "--", &command, title])
            .status()
            .map_err(|error| format!("Could not open Terminal: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "Could not open Terminal (osascript exited with {status})"
            ))
        }
    }

    struct RawModeGuard {
        fd: libc::c_int,
        original: libc::termios,
    }

    impl RawModeGuard {
        fn enter() -> io::Result<Self> {
            let fd = libc::STDIN_FILENO;
            let mut original = unsafe { std::mem::zeroed::<libc::termios>() };
            if unsafe { libc::tcgetattr(fd, &mut original) } != 0 {
                return Err(io::Error::last_os_error());
            }
            let mut raw = original;
            unsafe { libc::cfmakeraw(&mut raw) };
            if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { fd, original })
        }
    }

    impl Drop for RawModeGuard {
        fn drop(&mut self) {
            unsafe {
                libc::tcsetattr(self.fd, libc::TCSANOW, &self.original);
            }
        }
    }

    fn terminal_size() -> Option<(u16, u16)> {
        let mut size = unsafe { std::mem::zeroed::<libc::winsize>() };
        if unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut size) } == 0
            && size.ws_col > 0
            && size.ws_row > 0
        {
            Some((size.ws_col, size.ws_row))
        } else {
            None
        }
    }

    fn send_resize(stream: &mut UnixStream, size: (u16, u16)) -> io::Result<()> {
        let mut payload = Vec::with_capacity(4);
        payload.extend_from_slice(&size.0.to_be_bytes());
        payload.extend_from_slice(&size.1.to_be_bytes());
        write_frame(stream, RESIZE, &payload)
    }

    pub fn run_attach(socket_path: &str, token: &str) -> Result<(), String> {
        let mut stream = UnixStream::connect(socket_path)
            .map_err(|error| format!("Could not attach to NoMoreIDE: {error}"))?;
        write_frame(&mut stream, AUTH, token.as_bytes()).map_err(|error| error.to_string())?;
        let (kind, payload) = read_frame(&mut stream).map_err(|error| error.to_string())?;
        if kind == ERROR {
            return Err(String::from_utf8_lossy(&payload).into_owned());
        }
        if kind != ATTACHED {
            return Err("NoMoreIDE returned an invalid terminal handshake".to_string());
        }

        let _raw = RawModeGuard::enter().map_err(|error| error.to_string())?;
        let mut read_stream = stream.try_clone().map_err(|error| error.to_string())?;
        let writer = std::sync::Arc::new(std::sync::Mutex::new(stream));
        let input_writer = writer.clone();
        std::thread::spawn(move || {
            let mut stdin = io::stdin().lock();
            let mut buffer = [0u8; 4096];
            loop {
                match stdin.read(&mut buffer) {
                    Ok(0) | Err(_) => {
                        if let Ok(mut stream) = input_writer.lock() {
                            let _ = write_frame(&mut *stream, DETACH, &[]);
                        }
                        break;
                    }
                    Ok(count) => {
                        let result = input_writer.lock().map_err(|_| ()).and_then(|mut stream| {
                            write_frame(&mut *stream, INPUT, &buffer[..count]).map_err(|_| ())
                        });
                        if result.is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let initial_size = terminal_size();
        if let Some(size) = initial_size {
            let mut stream = writer
                .lock()
                .map_err(|_| "Terminal attachment lock failed")?;
            send_resize(&mut stream, size).map_err(|error| error.to_string())?;
        }
        let resize_writer = writer.clone();
        std::thread::spawn(move || {
            let mut last_size = initial_size;
            loop {
                std::thread::sleep(Duration::from_millis(250));
                let next_size = terminal_size();
                if next_size == last_size {
                    continue;
                }
                if let Some(size) = next_size {
                    let Ok(mut stream) = resize_writer.lock() else {
                        break;
                    };
                    if send_resize(&mut stream, size).is_err() {
                        break;
                    }
                }
                last_size = next_size;
            }
        });
        let mut stdout = io::stdout().lock();
        loop {
            match read_frame(&mut read_stream) {
                Ok((OUTPUT, data)) => {
                    stdout.write_all(&data).map_err(|error| error.to_string())?;
                    stdout.flush().map_err(|error| error.to_string())?;
                }
                Ok((REVOKED, _)) => break,
                Ok((ERROR, data)) => return Err(String::from_utf8_lossy(&data).into_owned()),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::{
            accept_authenticated, external_terminal_title, new_socket_path, posix_quote,
            read_frame, write_frame, SocketPathGuard, AUTH, ERROR, INPUT,
        };
        use std::io::ErrorKind;
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixStream;
        use std::time::{Duration, Instant};

        #[test]
        fn quotes_shell_values_as_data() {
            assert_eq!(posix_quote("a b'c;$()"), "'a b'\\''c;$()'");
        }

        #[test]
        fn external_title_identifies_and_sanitizes_the_agent() {
            assert_eq!(
                external_terminal_title(Some("codex"), Some("Fix parser")),
                "🟢 CODEX · Fix parser · NoMoreIDE"
            );
            assert_eq!(
                external_terminal_title(Some("claude"), Some("\u{1b}]2;spoof\u{7}  Review API")),
                "🟠 CLAUDE · ]2;spoof Review API · NoMoreIDE"
            );
            assert_eq!(
                external_terminal_title(Some("codex"), Some(" ")),
                "🟢 CODEX · Codex task · NoMoreIDE"
            );
        }

        #[test]
        fn frame_round_trip_preserves_raw_bytes() {
            let mut encoded = Vec::new();
            write_frame(&mut encoded, INPUT, &[0, 3, 255]).unwrap();
            let (kind, payload) = read_frame(&mut encoded.as_slice()).unwrap();
            assert_eq!(kind, INPUT);
            assert_eq!(payload, vec![0, 3, 255]);
        }

        #[test]
        fn private_socket_is_owner_only_and_removed_on_drop() {
            let path = new_socket_path();
            let (_listener, guard) = SocketPathGuard::bind(path.clone()).unwrap();

            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            drop(guard);
            assert!(!path.exists());
        }

        #[test]
        fn stalled_and_invalid_connectors_do_not_consume_the_auth_token() {
            let path = new_socket_path();
            let (listener, _guard) = SocketPathGuard::bind(path.clone()).unwrap();
            let stalled = UnixStream::connect(&path).unwrap();
            let mut invalid = UnixStream::connect(&path).unwrap();
            write_frame(&mut invalid, AUTH, b"wrong").unwrap();
            let mut valid = UnixStream::connect(&path).unwrap();
            write_frame(&mut valid, AUTH, b"secret").unwrap();

            let accepted = accept_authenticated(
                &listener,
                b"secret",
                Instant::now() + Duration::from_secs(1),
                Duration::from_millis(50),
                || true,
            )
            .unwrap();

            assert!(accepted.is_some());
            let (kind, _) = read_frame(&mut invalid).unwrap();
            assert_eq!(kind, ERROR);
            drop(stalled);
            valid
                .set_read_timeout(Some(Duration::from_millis(50)))
                .unwrap();
            assert_eq!(
                read_frame(&mut valid).unwrap_err().kind(),
                ErrorKind::WouldBlock
            );
        }

        #[test]
        fn authentication_stops_at_the_overall_deadline() {
            let path = new_socket_path();
            let (listener, _guard) = SocketPathGuard::bind(path.clone()).unwrap();
            let _stalled = UnixStream::connect(&path).unwrap();
            let started = Instant::now();

            let accepted = accept_authenticated(
                &listener,
                b"secret",
                started + Duration::from_millis(80),
                Duration::from_secs(1),
                || true,
            )
            .unwrap();

            assert!(accepted.is_none());
            assert!(started.elapsed() < Duration::from_millis(500));
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
pub fn run_attach(_socket_path: &str, _token: &str) -> Result<(), String> {
    Err("External Terminal is currently available on macOS only".to_string())
}
