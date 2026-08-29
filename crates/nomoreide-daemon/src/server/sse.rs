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
    /// The comment written every fifteen seconds.
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

/// The terminal stream's, which shares none of the above.
pub(crate) const CONNECTED_AND_KEEPALIVE: Framing = Framing {
    prologue: ": connected\n\n",
    heartbeat: ": keepalive\n\n",
    content_type: "text/event-stream; charset=utf-8",
    no_buffering: true,
};

/// One frame: `event: <name>` and its JSON payload.
///
/// A value that will not serialize contributes no frame rather than a broken
/// one — half a frame would desynchronise every frame after it.
fn frame(event: &str, payload: &impl Serialize) -> Option<Bytes> {
    let data = serde_json::to_string(payload).ok()?;
    Some(Bytes::from(format!("event: {event}\ndata: {data}\n\n")))
}

/// Open a stream: the prologue, then `replay`, then everything `live` carries
/// until the client leaves.
///
/// `live` is the **sender**, not a receiver, and the writing task keeps it
/// alive for as long as the connection lasts. That is what lets a stream with
/// no producer — the pending-trigger queue, which nothing fires yet — stay open
/// and heartbeat instead of closing the moment it finds the channel empty.
///
/// `wire` maps a broadcast value to the payload to send, and `None` drops it:
/// one channel can carry several kinds of event, and a stream takes only its
/// own.
pub(crate) fn stream<T, S, W>(
    framing: Framing,
    event: &'static str,
    replay: Vec<S>,
    live: broadcast::Sender<T>,
    wire: W,
) -> Response
where
    T: Clone + Send + 'static,
    W: Fn(T) -> Option<S> + Send + 'static,
    S: Serialize + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(64);
    tokio::spawn(async move {
        let mut received = live.subscribe();
        let mut prologue = vec![Bytes::from(framing.prologue)];
        prologue.extend(replay.iter().filter_map(|value| frame(event, value)));
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
                    Ok(value) => match wire(value).as_ref().and_then(|payload| frame(event, payload)) {
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
