//! Server-sent event responses, framed by hand.
//!
//! Not `axum::response::sse`, deliberately. An event stream is a wire format
//! the dashboard's `EventSource` parses, and the reference writes it byte for
//! byte: `retry: 2000`, `event: <name>`, `data: <json>`, a blank line to end
//! each frame, and `: ping` as a comment. Axum's renderer spells some of that
//! differently — a comment with no space after the colon, for one — and a
//! stream that differs in its framing is a stream a client reconnects to
//! differently. So the bytes are written here.
//!
//! **Unsubscribing is the drop.** Each connection holds a broadcast receiver;
//! when the client goes away axum drops the body, the sender half fails, and
//! the task ends. Nothing has to remember to deregister a callback, which is
//! the leak a dashboard reload would otherwise cause.

use axum::body::{Body, Bytes};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use std::time::Duration;
use tokio::sync::broadcast;

/// How often a comment frame goes out to keep an idle connection open. Long
/// enough to be cheap, short enough to beat the usual proxy idle timeout.
const HEARTBEAT: Duration = Duration::from_secs(15);
/// The reconnect delay the client is told to use, in milliseconds.
const RETRY_MS: u64 = 2_000;

/// One frame: `event: <name>` and its JSON payload.
///
/// A value that will not serialize contributes no frame rather than a broken
/// one — half a frame would desynchronise every frame after it.
fn frame(event: &str, payload: &impl Serialize) -> Option<Bytes> {
    let data = serde_json::to_string(payload).ok()?;
    Some(Bytes::from(format!("event: {event}\ndata: {data}\n\n")))
}

/// Open a stream: the retry hint, then `replay`, then everything `live`
/// carries until the client leaves.
///
/// `wire` is applied to each live value, so a route can send the same shape it
/// serves from its JSON endpoint rather than core's internal one.
pub(crate) fn stream<T, W, S>(
    event: &'static str,
    replay: Vec<S>,
    mut live: broadcast::Receiver<T>,
    wire: W,
) -> Response
where
    T: Clone + Send + 'static,
    W: Fn(T) -> S + Send + 'static,
    S: Serialize + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(64);
    tokio::spawn(async move {
        let mut prologue = vec![Bytes::from(format!("retry: {RETRY_MS}\n\n"))];
        prologue.extend(replay.iter().filter_map(|value| frame(event, value)));
        for chunk in prologue {
            if tx.send(chunk).await.is_err() {
                return;
            }
        }
        let mut heartbeat = tokio::time::interval(HEARTBEAT);
        // The first tick is immediate; the reference's timer starts counting
        // at connect, so that one is spent here rather than sent.
        heartbeat.tick().await;
        loop {
            let chunk = tokio::select! {
                received = live.recv() => match received {
                    Ok(value) => match frame(event, &wire(value)) {
                        Some(chunk) => chunk,
                        None => continue,
                    },
                    // A reader that fell too far behind keeps its stream and
                    // misses what it missed; a closed sender ends it.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                _ = heartbeat.tick() => Bytes::from_static(b": ping\n\n"),
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
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .header(header::CONNECTION, "keep-alive")
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
