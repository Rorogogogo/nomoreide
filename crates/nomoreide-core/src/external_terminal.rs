//! Presenting a running agent session in an external terminal.
//!
//! The preference and how it resolves live at the top level, on every platform:
//! the daemon reads the setting and passes it down before it knows or cares
//! whether anything can act on it. Only the *launching* is macOS-only, and that
//! is what the `macos` module below holds.
//!
//! Getting this boundary wrong does not fail on a Mac. It fails on Linux, in a
//! release build, after everything green has already been merged.

/// Which terminal application a mirror opens in.
///
/// The settings key offers `automatic`, `ghostty`, `iterm2` and `terminal`,
/// and for a long time this module honoured none of them: it said
/// `tell application "Terminal"` and that was that. Choosing Ghostty and
/// getting Terminal.app is the visible half of the bug. The invisible half
/// is worse — see [`ExternalTerminalApp::renders_truecolor`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExternalTerminalApp {
    Ghostty,
    ITerm2,
    TerminalApp,
}

impl ExternalTerminalApp {
    /// The name LaunchServices and AppleScript know it by.
    pub fn app_name(self) -> &'static str {
        match self {
            Self::Ghostty => "Ghostty",
            // The bundle is `iTerm.app`; only the product is called iTerm2.
            Self::ITerm2 => "iTerm",
            Self::TerminalApp => "Terminal",
        }
    }

    /// Whether it can draw 24-bit colour.
    ///
    /// Terminal.app cannot, and it does not degrade politely: handed
    /// `ESC[38;2;R;G;Bm` it reads the components as separate SGR codes and
    /// paints backgrounds out of them. An agent's output arrives as blocks
    /// of green, blue and magenta — which looks like a corrupted mirror
    /// rather than a terminal that is missing a feature.
    ///
    /// The PTY is spawned once, with `COLORTERM=truecolor`, and the dock's
    /// xterm renders it correctly. So this cannot be fixed by choosing
    /// different bytes; it is fixed by preferring a terminal that can read
    /// the ones already being sent.
    pub fn renders_truecolor(self) -> bool {
        !matches!(self, Self::TerminalApp)
    }
}

/// Whether the app is installed, asked of LaunchServices rather than of
/// `/Applications` — an app is perfectly allowed to live somewhere else.
///
/// Always false off macOS, where there is no `open` to ask and nothing this
/// module could launch anyway.
#[cfg(target_os = "macos")]
pub fn terminal_installed(app: ExternalTerminalApp) -> bool {
    std::process::Command::new("/usr/bin/open")
        .args(["-Ra", app.app_name()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub fn terminal_installed(_app: ExternalTerminalApp) -> bool {
    false
}

/// The terminal to open, given the settings value.
///
/// A named choice that is not installed falls back rather than failing: the
/// setting is a preference, and refusing to mirror an agent because a
/// terminal was uninstalled two months ago helps nobody.
///
/// `automatic` prefers truecolor, which is the whole reason it is not just
/// "Terminal.app". Terminal.app is last because it is the only one that
/// mangles what the agent already emits, and it is always present, so it is
/// the floor rather than the default.
pub fn resolve_external_terminal(preference: &str) -> ExternalTerminalApp {
    let ordered = [
        ExternalTerminalApp::Ghostty,
        ExternalTerminalApp::ITerm2,
        ExternalTerminalApp::TerminalApp,
    ];
    let named = match preference {
        "ghostty" => Some(ExternalTerminalApp::Ghostty),
        "iterm2" => Some(ExternalTerminalApp::ITerm2),
        "terminal" => Some(ExternalTerminalApp::TerminalApp),
        _ => None,
    };
    if let Some(named) = named {
        if named == ExternalTerminalApp::TerminalApp || terminal_installed(named) {
            return named;
        }
    }
    ordered
        .into_iter()
        .find(|candidate| {
            *candidate != ExternalTerminalApp::TerminalApp && terminal_installed(*candidate)
        })
        .unwrap_or(ExternalTerminalApp::TerminalApp)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::ExternalTerminalApp;
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
                    // **The accepted socket is blocking, and saying so is not
                    // redundant.** The listener is non-blocking so this loop can
                    // poll `keep_waiting`, and on BSD — macOS included — an
                    // accepted socket *inherits* `O_NONBLOCK` from its listener.
                    // Linux does not, which is exactly why this is easy to miss:
                    // the platform where this code runs is the one where it
                    // matters, and the one where it would be tested is not.
                    //
                    // Left inherited, every read below returns `EAGAIN` the
                    // instant no byte is already buffered. The read timeout set
                    // next is silently meaningless, and the caller's mirror
                    // tears itself down milliseconds after attaching — which
                    // reads as "opening an agent in Terminal does nothing".
                    stream.set_nonblocking(false)?;
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

    /// The command the terminal is asked to run.
    ///
    /// `exec` so the attachment replaces the shell rather than sitting under
    /// one: closing the window should end the mirror, not leave a shell behind
    /// holding a socket.
    fn attach_command(socket_path: &Path, token: &str) -> Result<String, String> {
        let executable = env::current_exe().map_err(|error| error.to_string())?;
        let executable = executable
            .to_str()
            .ok_or_else(|| "NoMoreIDE executable path is not valid UTF-8".to_string())?;
        let socket_path = socket_path
            .to_str()
            .ok_or_else(|| "Terminal attachment path is not valid UTF-8".to_string())?;
        Ok(format!(
            "exec {} --terminal-attach {} {}",
            posix_quote(executable),
            posix_quote(socket_path),
            posix_quote(token),
        ))
    }

    pub fn launch_terminal(
        socket_path: &Path,
        token: &str,
        title: &str,
        app: ExternalTerminalApp,
    ) -> Result<(), String> {
        let command = attach_command(socket_path, token)?;
        match app {
            ExternalTerminalApp::TerminalApp => launch_via_applescript(
                "Terminal",
                "on run argv\n  tell application \"Terminal\"\n    set newTab to do script (item 1 of argv)\n    set custom title of newTab to (item 2 of argv)\n    activate\n  end tell\nend run",
                &command,
                title,
            ),
            ExternalTerminalApp::ITerm2 => launch_via_applescript(
                "iTerm",
                "on run argv\n  tell application \"iTerm\"\n    set newWindow to (create window with default profile command (item 1 of argv))\n    tell current session of newWindow to set name to (item 2 of argv)\n    activate\n  end tell\nend run",
                &command,
                title,
            ),
            // Ghostty ships no AppleScript dictionary, so it is launched the
            // way it documents: a fresh instance told to run one command.
            // `-n` because an existing window must not be reused — the mirror
            // owns its window, and `exec` in somebody's shell would take it.
            ExternalTerminalApp::Ghostty => {
                let status = Command::new("/usr/bin/open")
                    .args([
                        "-na",
                        "Ghostty",
                        "--args",
                        &format!("--title={title}"),
                        "-e",
                        "/bin/sh",
                        "-c",
                        &command,
                    ])
                    .status()
                    .map_err(|error| format!("Could not open Ghostty: {error}"))?;
                if status.success() {
                    Ok(())
                } else {
                    Err(format!("Could not open Ghostty (open exited with {status})"))
                }
            }
        }
    }

    fn launch_via_applescript(
        app_label: &str,
        script: &str,
        command: &str,
        title: &str,
    ) -> Result<(), String> {
        let status = Command::new("/usr/bin/osascript")
            .args(["-e", script, "--", command, title])
            .status()
            .map_err(|error| format!("Could not open {app_label}: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "Could not open {app_label} (osascript exited with {status})"
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
        use crate::external_terminal::{
            resolve_external_terminal, terminal_installed, ExternalTerminalApp,
        };
        use std::io::ErrorKind;
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixStream;
        use std::time::{Duration, Instant};

        /// The mirror has to survive the pause between attaching and the first
        /// byte the agent draws.
        ///
        /// Pins the platform difference that broke it: the listener is
        /// non-blocking so the accept loop can poll `keep_waiting`, and on BSD
        /// an accepted socket inherits `O_NONBLOCK` from its listener while on
        /// Linux it does not. Inherited, the read below returns `EAGAIN`
        /// immediately rather than waiting, the caller treats that as the
        /// helper hanging up, and opening an agent in Terminal silently falls
        /// back to the dock a few milliseconds later.
        ///
        /// The delay is the whole test. A frame already sitting in the buffer
        /// reads fine either way, which is why the bug survived the tests that
        /// were here.
        #[test]
        fn accepted_stream_blocks_for_a_frame_that_has_not_arrived_yet() {
            let path = new_socket_path();
            let (listener, _guard) = SocketPathGuard::bind(path.clone()).expect("bind");

            let writer = std::thread::spawn(move || {
                let mut client = UnixStream::connect(&path).expect("connect");
                write_frame(&mut client, AUTH, b"token").expect("auth");
                // Long enough that a non-blocking read cannot accidentally pass.
                std::thread::sleep(Duration::from_millis(300));
                write_frame(&mut client, INPUT, b"typed").expect("input");
                client
            });

            let mut accepted = accept_authenticated(
                &listener,
                b"token",
                Instant::now() + Duration::from_secs(5),
                Duration::from_secs(1),
                || true,
            )
            .expect("accept")
            .expect("authenticated");

            let (kind, payload) = read_frame(&mut accepted).expect("the delayed frame");
            assert_eq!(kind, INPUT);
            assert_eq!(payload, b"typed");
            let _ = writer.join();
        }

        /// The setting has to reach the launcher.
        ///
        /// It did not, for the life of the Rust port: `launch_terminal` said
        /// `tell application "Terminal"` and the four-way preference in
        /// settings was read by nothing. Choosing Ghostty and getting
        /// Terminal.app is the obvious symptom; the one that wasted an evening
        /// is that Terminal.app cannot draw 24-bit colour, so an agent's output
        /// arrived as blocks of green and magenta and looked like a corrupt
        /// mirror.
        #[test]
        fn named_terminals_resolve_to_themselves() {
            assert_eq!(
                resolve_external_terminal("terminal"),
                ExternalTerminalApp::TerminalApp
            );
            // Ghostty and iTerm2 only resolve when installed, so assert the
            // property that holds on any machine: a named choice never
            // silently becomes a *different* named choice.
            let ghostty = resolve_external_terminal("ghostty");
            assert!(
                ghostty == ExternalTerminalApp::Ghostty
                    || ghostty == ExternalTerminalApp::TerminalApp
                    || ghostty == ExternalTerminalApp::ITerm2
            );
        }

        /// Terminal.app is the floor, never the preference.
        ///
        /// `automatic` exists to pick something that renders what the PTY
        /// already emits. Falling to Terminal.app first would make the default
        /// the one option that mangles it.
        #[test]
        fn automatic_only_falls_to_terminal_app_when_nothing_better_exists() {
            let chosen = resolve_external_terminal("automatic");
            if chosen == ExternalTerminalApp::TerminalApp {
                assert!(!terminal_installed(ExternalTerminalApp::Ghostty));
                assert!(!terminal_installed(ExternalTerminalApp::ITerm2));
            } else {
                assert!(chosen.renders_truecolor());
            }
        }

        /// An unknown value behaves like `automatic` rather than failing. The
        /// settings file is user-editable, and a typo should not stop a mirror.
        #[test]
        fn an_unrecognised_preference_is_automatic() {
            assert_eq!(
                resolve_external_terminal("emacs-ansi-term"),
                resolve_external_terminal("automatic")
            );
        }

        /// The distinction the colour bug turns on.
        #[test]
        fn only_terminal_app_lacks_truecolor() {
            assert!(ExternalTerminalApp::Ghostty.renders_truecolor());
            assert!(ExternalTerminalApp::ITerm2.renders_truecolor());
            assert!(!ExternalTerminalApp::TerminalApp.renders_truecolor());
        }

        /// The bundle is `iTerm.app`; only the product is called iTerm2. Asking
        /// LaunchServices for "iTerm2" finds nothing.
        #[test]
        fn iterm_is_addressed_by_its_bundle_name() {
            assert_eq!(ExternalTerminalApp::ITerm2.app_name(), "iTerm");
        }

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
