//! Server-sent event responses, framed by hand.
//!
//! Not `axum::response::sse`, deliberately. An event stream is a wire format
//! the dashboard's `EventSource` parses, and the reference writes it byte for
//! byte: `retry: 2000`, `event: <name>`, `data: <json>`, a blank line to end
//! each frame, and a comment as a heartbeat. Axum's renderer spells some of
//! that differently — a comment with no space after the colon, for one — and a
//! stream that differs in its framing is a stream a client reconnects to
//! differently. So the bytes are written here.
//!
//! **There is no single house style.** The trigger queue and the error inbox
//! open with `retry: 2000` and beat with `: ping`; the terminal stream opens
//! with `: connected`, beats with `: keepalive`, declares a charset, and asks a
//! reverse proxy not to buffer it. Both spellings are the reference's, so
//! [`Framing`] carries the difference rather than one of them being normalised
//! onto the other.
//!
//! **Unsubscribing is the drop.** Each connection holds a broadcast receiver;
//! when the client goes away axum drops the body, the channel to the writing
//! task fails, and the task ends. Nothing has to remember to deregister a
//! callback, which is the leak a dashboard reload would otherwise cause.

use axum::body::{Body, Bytes};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use std::time::Duration;
use tokio::sync::broadcast;

/// How often a comment frame goes out to keep an idle connection open. Long
/// enough to be cheap, short enough to beat the usual proxy idle timeout.
const HEARTBEAT: Duration = Duration::from_secs(15);

/// The bytes that differ between one stream and another.
#[derive(Clone, Copy)]
pub(crate) struct Framing {
    /// Written before anything else, replay included.
    pub prologue: &'static str,
    /// The comment written every fifteen seconds, or `""` for a stream that
    /// does not beat at all. A chat turn is the latter: it is a job with an
    /// end, and the reference sets no timer on it.
    pub heartbeat: &'static str,
    pub content_type: &'static str,
    /// Whether to tell nginx not to buffer. Only the terminal stream does.
    pub no_buffering: bool,
}

/// What most streams use: a reconnect hint and `: ping`.
pub(crate) const RETRY_AND_PING: Framing = Framing {
    prologue: "retry: 2000\n\n",
    heartbeat: ": ping\n\n",
    content_type: "text/event-stream",
    no_buffering: false,
};

/// One agent turn: the same opening as most streams, no heartbeat, and no
/// `event:` name on any frame — the dashboard reads the `type` inside the JSON.
pub(crate) const CHAT_TURN: Framing = Framing {
    prologue: "retry: 2000\n\n",
    heartbeat: "",
    content_type: "text/event-stream",
    no_buffering: false,
};

/// The terminal stream's, which shares none of the above.
pub(crate) const CONNECTED_AND_KEEPALIVE: Framing = Framing {
    prologue: ": connected\n\n",
    heartbeat: ": keepalive\n\n",
    content_type: "text/event-stream; charset=utf-8",
    no_buffering: true,
};

/// One frame's `event:` name and its payload.
///
/// The name is carried per frame rather than per stream because it is not
/// always fixed: a test run emits `status`, then `output`, then `status`
/// again. A stream whose name never changes just says the same one each time.
pub(crate) struct Frame<S> {
    /// `None` writes no `event:` line at all, which is a legitimate SSE frame
    /// and what the chat stream sends.
    pub event: Option<String>,
    pub payload: S,
}

/// A frame with a fixed name, which is what most streams want.
pub(crate) fn named<S>(event: &str, payload: S) -> Frame<S> {
    Frame {
        event: Some(event.to_string()),
        payload,
    }
}

/// A frame carrying only data.
pub(crate) fn unnamed<S>(payload: S) -> Frame<S> {
    Frame {
        event: None,
        payload,
    }
}

/// Render one frame.
///
/// A value that will not serialize contributes no frame rather than a broken
/// one — half a frame would desynchronise every frame after it.
fn render<S: Serialize>(frame: &Frame<S>) -> Option<Bytes> {
    let data = serde_json::to_string(&frame.payload).ok()?;
    Some(Bytes::from(match &frame.event {
        Some(event) => format!("event: {event}\ndata: {data}\n\n"),
        None => format!("data: {data}\n\n"),
    }))
}

/// Where a [`driven`] stream's frames are written.
///
/// `send` answers whether the client is still there, so a producer can stop
/// early rather than run a whole install nobody is reading.
pub(crate) struct Sink {
    tx: tokio::sync::mpsc::Sender<Bytes>,
}

impl Sink {
    pub(crate) async fn send<S: Serialize>(&self, frame: Frame<S>) -> bool {
        match render(&frame) {
            Some(chunk) => self.tx.send(chunk).await.is_ok(),
            // A payload that will not serialize contributes nothing, but the
            // connection is still good.
            None => true,
        }
    }
}

/// A stream whose frames come from work this daemon is doing, and which **ends
/// when that work does**.
///
/// The counterpart to [`stream`]: that one subscribes to something other parts
/// publish onto and stays open indefinitely, this one runs a job and closes.
/// The heartbeat still beats underneath, because the job may be a long install
/// that says nothing for minutes — and it stops with the job, which is the
/// reference's `clearInterval` in its `finally`.
pub(crate) fn driven<F, Fut>(framing: Framing, run: F) -> Response
where
    F: FnOnce(Sink) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(64);
    tokio::spawn(async move {
        if tx.send(Bytes::from(framing.prologue)).await.is_err() {
            return;
        }
        let work = run(Sink { tx: tx.clone() });
        let mut work = std::pin::pin!(work);
        if framing.heartbeat.is_empty() {
            work.await;
            return;
        }
        let mut heartbeat = tokio::time::interval(HEARTBEAT);
        // The first tick is immediate; the reference's timer starts counting at
        // connect, so that one is spent here rather than sent.
        heartbeat.tick().await;
        loop {
            tokio::select! {
                _ = &mut work => return,
                _ = heartbeat.tick() => {
                    if tx.send(Bytes::from(framing.heartbeat)).await.is_err() {
                        return;
                    }
                }
            }
        }
    });
    respond(framing, rx)
}

/// Open a stream: the prologue, then `replay`, then everything `live` carries
/// until the client leaves.
///
/// `live` is the **sender**, not a receiver, and the writing task keeps it
/// alive for as long as the connection lasts. That is what lets a stream with
/// no producer — the pending-trigger queue, which nothing fires yet — stay open
/// and heartbeat instead of closing the moment it finds the channel empty.
///
/// `wire` maps a broadcast value to the frame to send, and `None` drops it:
/// one channel can carry several kinds of event, and a stream takes only its
/// own.
pub(crate) fn stream<T, S, W>(
    framing: Framing,
    replay: Vec<Frame<S>>,
    live: broadcast::Sender<T>,
    wire: W,
) -> Response
where
    T: Clone + Send + 'static,
    W: Fn(T) -> Option<Frame<S>> + Send + 'static,
    S: Serialize + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(64);
    tokio::spawn(async move {
        let mut received = live.subscribe();
        let mut prologue = vec![Bytes::from(framing.prologue)];
        prologue.extend(replay.iter().filter_map(render));
        for chunk in prologue {
            if tx.send(chunk).await.is_err() {
                return;
            }
        }
        let mut heartbeat = tokio::time::interval(HEARTBEAT);
        // The first tick is immediate; the reference's timer starts counting at
        // connect, so that one is spent here rather than sent.
        heartbeat.tick().await;
        loop {
            let chunk = tokio::select! {
                value = received.recv() => match value {
                    Ok(value) => match wire(value).as_ref().and_then(render) {
                        Some(chunk) => chunk,
                        // Not this stream's event, or one that would not
                        // serialize.
                        None => continue,
                    },
                    // A reader that fell behind misses what it missed and keeps
                    // its stream. A closed channel cannot happen while `live`
                    // is held here, but if it did the stream would still be
                    // open, so it keeps beating.
                    Err(_) => continue,
                },
                _ = heartbeat.tick() => Bytes::from(framing.heartbeat),
            };
            if tx.send(chunk).await.is_err() {
                return;
            }
        }
    });

    respond(framing, rx)
}

/// The headers and the body both kinds of stream share.
fn respond(framing: Framing, rx: tokio::sync::mpsc::Receiver<Bytes>) -> Response {
    let body = Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|chunk| (Ok::<Bytes, std::convert::Infallible>(chunk), rx))
    }));
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, framing.content_type)
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .header(header::CONNECTION, "keep-alive");
    if framing.no_buffering {
        response = response.header("x-accel-buffering", "no");
    }
    response
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
