//! The outbound socket: how a paired machine stays reachable without being
//! reachable.
//!
//! The daemon dials **out** over TLS and keeps one connection open. Nothing
//! here listens, binds, or asks anything of the user's router — a machine
//! running NoMoreIDE does not become addressable from the internet because
//! remote control is on. That is the property the whole feature is arranged
//! around, and it is worth defending against any future convenience that would
//! trade it away.
//!
//! Three behaviours matter more than the plumbing:
//!
//! **It reconnects forever, with jitter.** A relay that restarts brings every
//! daemon back at once unless each waits a different random moment, and a
//! thundering herd is how one deploy becomes an outage. Backoff is capped so a
//! machine that was offline overnight is back within half a minute of the
//! network returning, not hours later.
//!
//! **It never retries a command.** The connector reconnects; it does not
//! replay. A frame lost to a dropped socket is a frame the platform will send
//! again if it still wants the answer — and for a mutation it deliberately
//! will not. See the protocol's idempotency rules.
//!
//! **A refused credential stops it.** If the platform says the credential is no
//! longer good, this exits rather than looping — an orphaned daemon hammering a
//! revoke it does not understand is exactly the behaviour revocation exists to
//! prevent.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::Message;

use super::credentials::StoredCredential;
use super::protocol::device_bound::Empty;
use super::protocol::limits;
use super::protocol::platform_bound::SessionHello;
use super::protocol::version::{CapabilitySet, MINIMUM_SPEAKABLE_VERSION, SUPPORTED_VERSIONS};
use super::protocol::{envelope, DeviceBound, Envelope, PlatformBound};

/// Why a connection ended.
#[derive(Debug)]
pub enum Disconnected {
    /// The socket closed, or never opened. Try again later.
    Transient(String),
    /// The platform refused this credential. Stop.
    ///
    /// Distinguished from the above because looping on it is precisely what an
    /// orphaned daemon does, and revocation has to be able to end that.
    Refused(String),
}

impl std::fmt::Display for Disconnected {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transient(detail) => write!(formatter, "{detail}"),
            Self::Refused(detail) => write!(formatter, "credential refused: {detail}"),
        }
    }
}

/// A future returning the answer to one command.
pub type Answer<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = PlatformBound> + Send + 'a>>;

/// Where a dispatcher pushes frames nobody asked for.
///
/// An agent turn answers once — "accepted, run 3" — and then emits for as long
/// as it runs. Those events correlate to no request, so they cannot be the
/// return value of anything; they need a way out of the dispatcher that is not
/// the answer to a command.
///
/// Bounded, and deliberately: a relay that stopped reading must not be able to
/// stall the agent producing into it.
pub type EventSender = tokio::sync::mpsc::Sender<PlatformBound>;

/// How many unsolicited frames may queue for the socket.
pub const EVENT_QUEUE: usize = 256;

/// What the relay connection is doing, readable from outside the task.
///
/// Exists because "paired" and "connected" are different states and a user who
/// cannot tell them apart has no way to act. A credential on disk with nothing
/// attached looks healthy to every check that only reads the file, which is
/// exactly the state a freshly paired machine is in until something dials.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaySnapshot {
    /// A socket is attached right now.
    pub connected: bool,
    /// The connector gave up: the platform refused this credential. It will not
    /// retry, and only pairing again will change that.
    pub stopped: bool,
    pub device_id: String,
    pub device_name: String,
    pub platform_base_url: String,
    /// Why the last attempt ended, when it ended badly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// A shared, cloneable view of [`RelaySnapshot`].
#[derive(Clone, Default)]
pub struct RelayStatus(std::sync::Arc<std::sync::Mutex<RelaySnapshot>>);

impl RelayStatus {
    pub fn new(config: &ConnectorConfig, device_name: &str) -> Self {
        Self(std::sync::Arc::new(std::sync::Mutex::new(RelaySnapshot {
            connected: false,
            stopped: false,
            device_id: config.device_id.clone(),
            device_name: device_name.to_string(),
            platform_base_url: config.platform_base_url.clone(),
            last_error: None,
        })))
    }

    pub fn snapshot(&self) -> RelaySnapshot {
        self.0.lock().expect("relay status").clone()
    }

    fn set_connected(&self, connected: bool) {
        let mut status = self.0.lock().expect("relay status");
        status.connected = connected;
        if connected {
            status.last_error = None;
        }
    }

    fn record(&self, error: &Disconnected) {
        let mut status = self.0.lock().expect("relay status");
        status.connected = false;
        status.last_error = Some(error.to_string());
        status.stopped = matches!(error, Disconnected::Refused(_));
    }
}

/// What the connector does with a command, and how it answers.
///
/// A trait so the socket can be tested without a relay, and so the dispatcher —
/// which routes through the daemon's own router — can be swapped in without the
/// connector knowing what a service action means. The connector's job is
/// transport; deciding what a command *does* is deliberately somebody else's.
///
/// Written with an explicit boxed future rather than `#[async_trait]` because
/// this crate is published and does not otherwise carry that dependency. One
/// awkward signature is cheaper than a dependency in everybody's build.
pub trait CommandSink: Send + Sync {
    /// Handle one command, returning the frame that answers it.
    ///
    /// `events` is for everything that is *not* the answer — an agent run's
    /// output, which continues long after the command that started it has been
    /// replied to.
    fn dispatch<'a>(
        &'a self,
        request_id: &'a str,
        command: DeviceBound,
        events: EventSender,
    ) -> Answer<'a>;
}

/// Where to dial, and as whom.
#[derive(Debug, Clone)]
pub struct ConnectorConfig {
    pub device_id: String,
    pub credential: String,
    /// The platform's HTTP base. The socket URL is derived from it, so a
    /// deployment cannot end up with its API on one host and its relay on
    /// another by accident.
    pub platform_base_url: String,
    pub daemon_version: String,
    pub platform: String,
    pub capabilities: CapabilitySet,
}

impl ConnectorConfig {
    pub fn from_credential(stored: &StoredCredential) -> Self {
        Self {
            device_id: stored.device_id.clone(),
            credential: stored.credential.clone(),
            platform_base_url: stored.platform_base_url.clone(),
            daemon_version: env!("CARGO_PKG_VERSION").to_string(),
            platform: super::pairing::platform_name().to_string(),
            capabilities: CapabilitySet::current(),
        }
    }

    /// `https://…` → `wss://…/remote/ws/device`, `http://…` → `ws://…`.
    ///
    /// Derived rather than configured: a second setting is a second thing to get
    /// wrong, and the one case that matters — a developer on `http://127.0.0.1`
    /// — falls out of the scheme swap for free.
    pub fn socket_url(&self) -> String {
        let base = self.platform_base_url.trim_end_matches('/');
        let socket_base = match base.strip_prefix("https://") {
            Some(rest) => format!("wss://{rest}"),
            None => match base.strip_prefix("http://") {
                Some(rest) => format!("ws://{rest}"),
                None => base.to_string(),
            },
        };
        format!("{socket_base}/remote/ws/device")
    }
}

/// One connection, from dial to close.
///
/// Returns why it ended. The caller decides whether to try again — see
/// [`run_forever`].
pub async fn connect_once(
    config: &ConnectorConfig,
    commands: &dyn CommandSink,
    status: &RelayStatus,
) -> Disconnected {
    let mut request = match config.socket_url().into_client_request() {
        Ok(request) => request,
        Err(error) => return Disconnected::Refused(format!("bad relay URL: {error}")),
    };
    let bearer = match format!("Bearer {}", config.credential).parse() {
        Ok(value) => value,
        Err(_) => return Disconnected::Refused("credential is not a valid header".to_string()),
    };
    request.headers_mut().insert(AUTHORIZATION, bearer);

    let (socket, response) = match tokio_tungstenite::connect_async(request).await {
        Ok(connected) => connected,
        Err(tokio_tungstenite::tungstenite::Error::Http(response))
            if response.status().as_u16() == 401 || response.status().as_u16() == 403 =>
        {
            return Disconnected::Refused(format!("the platform answered {}", response.status()));
        }
        Err(error) => return Disconnected::Transient(error.to_string()),
    };
    let _ = response;

    let (mut sink, mut stream) = socket.split();

    // The hello is first, always. Until it lands the relay knows a credential
    // but not what this machine can do, and it will not route to a device whose
    // capabilities it has to guess at.
    let speaking = Speaking::new();
    let hello = frame(
        config,
        &speaking,
        PlatformBound::SessionHello(SessionHello {
            supported_versions: SUPPORTED_VERSIONS.to_vec(),
            daemon_version: config.daemon_version.clone(),
            platform: config.platform.clone(),
            capabilities: config.capabilities.clone(),
        }),
    );
    if let Err(error) = sink
        .send(Message::Text(
            envelope::encode_platform_bound(&hello).to_string(),
        ))
        .await
    {
        return Disconnected::Transient(error.to_string());
    }

    // Connected once the hello is away: the socket is open and the relay knows
    // what this machine can do.
    status.set_connected(true);

    let mut heartbeat = tokio::time::interval(limits::HEARTBEAT_INTERVAL);
    // The first tick fires immediately; the hello just went out, so skip it.
    heartbeat.tick().await;

    let (events, mut pending_events) = tokio::sync::mpsc::channel(EVENT_QUEUE);

    loop {
        tokio::select! {
            unsolicited = pending_events.recv() => {
                let Some(body) = unsolicited else {
                    // Only reachable if every sender is gone, which cannot
                    // happen while this loop holds one.
                    continue;
                };
                let frame = frame(config, &speaking, body);
                if let Err(error) = sink
                    .send(Message::Text(envelope::encode_platform_bound(&frame).to_string()))
                    .await
                {
                    return Disconnected::Transient(error.to_string());
                }
            }
            _ = heartbeat.tick() => {
                let beat = frame(config, &speaking, PlatformBound::SessionHeartbeat(Empty {}));
                if let Err(error) = sink
                    .send(Message::Text(envelope::encode_platform_bound(&beat).to_string()))
                    .await
                {
                    return Disconnected::Transient(error.to_string());
                }
            }
            message = stream.next() => {
                let Some(message) = message else {
                    return Disconnected::Transient("the relay closed the socket".to_string());
                };
                let message = match message {
                    Ok(message) => message,
                    Err(error) => return Disconnected::Transient(error.to_string()),
                };
                match message {
                    Message::Text(text) => {
                        match handle(config, &speaking, commands, text.as_bytes(), &events).await {
                            Ok(Some(answer)) => {
                                if let Err(error) = sink
                                    .send(Message::Text(
                                        envelope::encode_platform_bound(&answer).to_string(),
                                    ))
                                    .await
                                {
                                    return Disconnected::Transient(error.to_string());
                                }
                            }
                            Ok(None) => {}
                            Err(reason) => return reason,
                        }
                    }
                    Message::Close(_) => {
                        return Disconnected::Transient("the relay closed the socket".to_string());
                    }
                    // Binary is not part of this protocol; ping/pong are the
                    // library's business.
                    _ => {}
                }
            }
        }
    }
}

/// Handle one inbound frame. `Ok(None)` means nothing to send back.
async fn handle(
    config: &ConnectorConfig,
    speaking: &Speaking,
    commands: &dyn CommandSink,
    raw: &[u8],
    events: &EventSender,
) -> Result<Option<Envelope<PlatformBound>>, Disconnected> {
    let parsed = match envelope::parse_device_bound(raw, chrono::Utc::now()) {
        Ok(parsed) => parsed,
        Err(error) => {
            // Refusing loudly and carrying on: a relay one version ahead will
            // send names this build has never heard of, and disconnecting over
            // that would make every deploy an outage for older daemons.
            return Ok(Some(
                frame(
                    config,
                    speaking,
                    PlatformBound::CommandError(
                        super::protocol::platform_bound::CommandErrorResponse { error },
                    ),
                )
                .in_reply_to("unknown"),
            ));
        }
    };

    match parsed.body {
        // The relay's answer to our hello. Its choice of version is binding:
        // every frame from here on is stamped with it, because a peer that
        // asked us to speak 1 cannot read 2.
        DeviceBound::SessionWelcome(welcome) => {
            speaking.agreed(welcome.version);
            Ok(None)
        }
        // Advisory. The socket closing is the real revocation, and this stops
        // us reconnecting into a refusal loop.
        DeviceBound::SessionRevoke(revoke) => Err(Disconnected::Refused(revoke.reason)),
        command => {
            let answer = commands.dispatch(&parsed.id, command, events.clone()).await;
            Ok(Some(frame(config, speaking, answer).in_reply_to(parsed.id)))
        }
    }
}

/// The version this connection speaks, which is not necessarily the newest one
/// this build knows.
///
/// Starts at [`MINIMUM_SPEAKABLE_VERSION`] rather than [`PROTOCOL_VERSION`],
/// because the hello goes out *before* anything has been agreed and has to be
/// readable by a peer whose version is still unknown — including one older than
/// this build. The welcome then raises it to whatever the relay chose.
struct Speaking(std::sync::atomic::AtomicU32);

impl Speaking {
    fn new() -> Self {
        Self(std::sync::atomic::AtomicU32::new(MINIMUM_SPEAKABLE_VERSION))
    }

    fn get(&self) -> u32 {
        self.0.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn agreed(&self, version: u32) {
        self.0.store(version, std::sync::atomic::Ordering::Relaxed);
    }
}

fn frame(
    config: &ConnectorConfig,
    speaking: &Speaking,
    body: PlatformBound,
) -> Envelope<PlatformBound> {
    Envelope::at_version(
        speaking.get(),
        format!("evt_{}", uuid::Uuid::new_v4()),
        config.device_id.clone(),
        chrono::Utc::now(),
        body,
    )
}

/// Stay connected: dial, serve, and dial again.
///
/// Runs until the credential is refused, which is the one ending a daemon
/// should not argue with.
pub async fn run_forever(
    config: ConnectorConfig,
    commands: std::sync::Arc<dyn CommandSink>,
    status: RelayStatus,
) {
    let mut backoff = Backoff::new();
    loop {
        let started = std::time::Instant::now();
        let ended = connect_once(&config, commands.as_ref(), &status).await;
        status.record(&ended);
        // A connection that stayed up is evidence the platform is healthy, so
        // the next blip starts from one second again. Without this a daemon
        // that reconnected an hour ago carries that hour's backoff into a
        // moment's outage.
        if started.elapsed() >= limits::HEARTBEAT_INTERVAL {
            backoff.reset();
        }
        match ended {
            Disconnected::Refused(reason) => {
                eprintln!("nomoreide: remote control stopped — {reason}");
                eprintln!("nomoreide: run `nomoreide remote pair` to attach this machine again.");
                return;
            }
            Disconnected::Transient(_) => {
                tokio::time::sleep(backoff.next_delay()).await;
            }
        }
    }
}

/// Exponential backoff with jitter, capped.
///
/// The jitter is the point. Without it a relay restart brings every daemon back
/// in the same second, and the reconnect storm is worse than the outage.
pub struct Backoff {
    attempt: u32,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}

impl Backoff {
    pub fn new() -> Self {
        Self { attempt: 0 }
    }

    /// Reset after a connection that actually worked, so a long-lived daemon
    /// does not carry an hour-old backoff into its next blip.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    pub fn next_delay(&mut self) -> Duration {
        let base = Duration::from_secs(1)
            .saturating_mul(1u32 << self.attempt.min(5))
            .min(limits::RECONNECT_BACKOFF_CAP);
        self.attempt = self.attempt.saturating_add(1);
        jitter(base)
    }
}

/// Somewhere between half the delay and all of it.
///
/// No `rand` dependency for this: the low bits of the clock are a poor random
/// source in general and a perfectly good one for spreading reconnects, which
/// is all this has to do.
fn jitter(base: Duration) -> Duration {
    let millis = base.as_millis() as u64;
    if millis == 0 {
        return base;
    }
    let spread = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.subsec_nanos() as u64)
        .unwrap_or(0);
    Duration::from_millis(millis / 2 + spread % (millis / 2 + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(base: &str) -> ConnectorConfig {
        ConnectorConfig {
            device_id: "11111111-2222-3333-4444-555555555555".into(),
            credential: "c".repeat(64),
            platform_base_url: base.into(),
            daemon_version: "0.3.3".into(),
            platform: "macos".into(),
            capabilities: CapabilitySet::current(),
        }
    }

    #[test]
    fn a_production_base_dials_over_tls() {
        assert_eq!(
            config("https://api.nomoreide.com").socket_url(),
            "wss://api.nomoreide.com/remote/ws/device"
        );
    }

    /// A developer pointed at a local stack has to work too, and gets `ws://`
    /// without a second setting.
    #[test]
    fn a_loopback_base_dials_without_tls() {
        assert_eq!(
            config("http://127.0.0.1:3000").socket_url(),
            "ws://127.0.0.1:3000/remote/ws/device"
        );
    }

    #[test]
    fn a_trailing_slash_does_not_double() {
        assert_eq!(
            config("https://api.nomoreide.com/").socket_url(),
            "wss://api.nomoreide.com/remote/ws/device"
        );
    }

    /// Backoff has to climb, and has to stop climbing.
    #[test]
    fn backoff_grows_and_is_capped() {
        let mut backoff = Backoff::new();
        let mut previous = Duration::ZERO;
        for _ in 0..12 {
            let delay = backoff.next_delay();
            assert!(delay <= limits::RECONNECT_BACKOFF_CAP, "{delay:?}");
            previous = delay;
        }
        assert!(
            previous >= limits::RECONNECT_BACKOFF_CAP / 2,
            "{previous:?}"
        );
    }

    #[test]
    fn a_reset_backoff_starts_over() {
        let mut backoff = Backoff::new();
        for _ in 0..6 {
            backoff.next_delay();
        }
        backoff.reset();

        assert!(backoff.next_delay() <= Duration::from_secs(1));
    }

    /// Never zero, never more than the base — a delay of nothing is a hot loop.
    #[test]
    fn jitter_stays_within_half_the_delay_and_all_of_it() {
        for base in [Duration::from_secs(1), Duration::from_secs(30)] {
            for _ in 0..200 {
                let delayed = jitter(base);
                assert!(delayed >= base / 2, "{delayed:?} < {base:?}/2");
                assert!(delayed <= base, "{delayed:?} > {base:?}");
            }
        }
    }

    /// A refused credential must read differently from a dropped connection, or
    /// an orphaned daemon reconnects into a refusal forever.
    #[test]
    fn a_refusal_is_not_a_transient_failure() {
        assert!(matches!(
            Disconnected::Refused("revoked".into()),
            Disconnected::Refused(_)
        ));
        assert!(Disconnected::Refused("revoked".into())
            .to_string()
            .contains("credential refused"));
    }

    /// The compatibility rule v2 turns on.
    ///
    /// A hello goes out before anything has been agreed, so it is stamped with
    /// the oldest version this build speaks — otherwise a daemon one version
    /// ahead of the relay would be unreadable at the only moment it has to be
    /// understood, and could never negotiate its way down.
    #[test]
    fn the_hello_is_stamped_low_enough_for_an_older_relay_to_read() {
        assert_eq!(Speaking::new().get(), MINIMUM_SPEAKABLE_VERSION);
    }

    /// And once the relay has chosen, that choice is what goes on the wire —
    /// including when it is lower than this build would have preferred.
    #[test]
    fn the_relays_choice_is_what_later_frames_carry() {
        let speaking = Speaking::new();
        speaking.agreed(1);
        assert_eq!(speaking.get(), 1);

        speaking.agreed(super::super::protocol::version::PROTOCOL_VERSION);
        assert_eq!(
            speaking.get(),
            super::super::protocol::version::PROTOCOL_VERSION
        );
    }
}
