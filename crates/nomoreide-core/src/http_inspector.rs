//! A reverse proxy that watches one service's HTTP traffic.
//!
//! Stood in front of a running service on an ephemeral port: every request is
//! forwarded upstream unchanged and reported to a callback, so the dashboard
//! can show what a browser is actually asking the service for without the
//! service knowing anything about it.
//!
//! **Transparent or it is useless.** The status, the headers and the body all
//! pass through as they came, and a WebSocket upgrade is handed off as a raw
//! byte pipe rather than being parsed. The one header that changes is `Host`,
//! which is rewritten to the upstream so a service that vhosts on it still
//! answers.
//!
//! **An upstream that refuses is a 502 from here**, and still an event — a
//! request that failed to connect is exactly the sort a developer opened this
//! to see.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// One request, as the timeline records it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpInspectorEvent {
    pub id: String,
    pub started_at: DateTime<Utc>,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub duration_ms: f64,
    pub req_bytes: usize,
    pub res_bytes: usize,
}

/// A running inspector, and the way to take it down.
pub struct HttpInspectorHandle {
    pub port: u16,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl HttpInspectorHandle {
    /// Stop accepting, and drop the connections still open.
    ///
    /// Taking the sender rather than closing a socket is what makes this safe
    /// to call twice: the second call has nothing to send and does nothing.
    pub fn stop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

impl Drop for HttpInspectorHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Stand an inspector in front of `upstream_port`.
///
/// Binds loopback only. This forwards to a developer's own service with no
/// authentication of its own, so it must not be a hole punched in the machine.
pub async fn start(
    upstream_port: u16,
    on_event: impl Fn(HttpInspectorEvent) + Send + Sync + 'static,
) -> Result<HttpInspectorHandle, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("Could not start the inspector: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let (shutdown, mut stopped) = tokio::sync::oneshot::channel();
    let on_event = Arc::new(on_event);

    tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                _ = &mut stopped => return,
                accepted = listener.accept() => accepted,
            };
            let Ok((client, _)) = accepted else { continue };
            let on_event = on_event.clone();
            tokio::spawn(async move {
                let _ = proxy(client, upstream_port, on_event).await;
            });
        }
    });

    Ok(HttpInspectorHandle {
        port,
        shutdown: Some(shutdown),
    })
}

/// One client connection, forwarded until either side goes quiet.
///
/// The request head is parsed only far enough to report it and rewrite `Host`;
/// everything else — pipelining, chunked bodies, upgrades — is bytes, which is
/// what keeps this transparent to protocols it has never heard of.
async fn proxy(
    mut client: TcpStream,
    upstream_port: u16,
    on_event: Arc<impl Fn(HttpInspectorEvent) + Send + Sync + 'static>,
) -> std::io::Result<()> {
    let started_at = Utc::now();
    let started = Instant::now();

    let mut head = Vec::new();
    let mut buffer = [0u8; 8192];
    // Read until the blank line that ends the request head, or until the client
    // stops talking.
    let head_end = loop {
        let read = client.read(&mut buffer).await?;
        if read == 0 {
            return Ok(());
        }
        head.extend_from_slice(&buffer[..read]);
        if let Some(end) = find_head_end(&head) {
            break end;
        }
        if head.len() > 64 * 1024 {
            return Ok(());
        }
    };

    let (method, path) = request_line(&head).unwrap_or_else(|| ("GET".into(), "/".into()));
    let upstream_host = format!("127.0.0.1:{upstream_port}");
    let rewritten = rewrite_head(&head[..head_end], &upstream_host);
    let leftover = head[head_end..].to_vec();

    let mut upstream = match TcpStream::connect(("127.0.0.1", upstream_port)).await {
        Ok(upstream) => upstream,
        Err(error) => {
            let body = format!("Inspector upstream error: {error}");
            let _ = client
                .write_all(
                    format!(
                        "HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await;
            on_event(HttpInspectorEvent {
                id: uuid::Uuid::new_v4().to_string(),
                started_at,
                method,
                path,
                status: 502,
                duration_ms: elapsed(started),
                req_bytes: 0,
                res_bytes: 0,
            });
            return Ok(());
        }
    };

    upstream.write_all(&rewritten).await?;
    if !leftover.is_empty() {
        upstream.write_all(&leftover).await?;
    }

    let (mut client_read, mut client_write) = client.into_split();
    let (mut upstream_read, mut upstream_write) = upstream.into_split();

    // The rest of the request body, forwarded and counted as it goes.
    //
    // Counted through a shared cell rather than returned, because this task
    // cannot be waited on: a keep-alive client holds its socket open after the
    // response, so joining here would park until the *client* went away and the
    // event would never be reported.
    // Seeded with whatever body arrived alongside the head: a small POST is one
    // packet, so its whole body is already in hand and the pump below never
    // sees it.
    let request_bytes = Arc::new(AtomicUsize::new(leftover.len()));
    let counted = request_bytes.clone();
    tokio::spawn(async move {
        let mut buffer = [0u8; 8192];
        while let Ok(read) = client_read.read(&mut buffer).await {
            if read == 0 {
                break;
            }
            counted.fetch_add(read, Ordering::Relaxed);
            if upstream_write.write_all(&buffer[..read]).await.is_err() {
                break;
            }
        }
        let _ = upstream_write.shutdown().await;
    });

    // The response. Every byte is forwarded, but only the *body* is counted —
    // the reference counts what its HTTP parser hands it, which is the body
    // alone, so counting the head here would inflate every row by the size of
    // its headers.
    //
    // The stream ends when the upstream closes, which it does after one
    // response because the head sent up asked it to — see `rewrite_head`.
    let mut response_bytes = 0usize;
    let mut status = 0u16;
    let mut head_seen = false;
    let mut response_head: Vec<u8> = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = match upstream_read.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        if head_seen {
            response_bytes += read;
        } else {
            response_head.extend_from_slice(&buffer[..read]);
            if let Some(end) = find_head_end(&response_head) {
                head_seen = true;
                status = status_of(&response_head).unwrap_or(0);
                // Whatever of the body came in the same read as the head.
                response_bytes += response_head.len() - end;
                response_head = Vec::new();
            } else if response_head.len() > 64 * 1024 {
                // Not a response head this can make sense of; forward the rest
                // blind rather than buffering it forever.
                head_seen = true;
                response_head = Vec::new();
            }
        }
        if client_write.write_all(&buffer[..read]).await.is_err() {
            break;
        }
    }
    let _ = client_write.shutdown().await;

    let req_bytes = request_bytes.load(Ordering::Relaxed);
    on_event(HttpInspectorEvent {
        id: uuid::Uuid::new_v4().to_string(),
        started_at,
        method,
        path,
        status,
        duration_ms: elapsed(started),
        req_bytes,
        res_bytes: response_bytes,
    });
    Ok(())
}

/// Rounded to a tenth of a millisecond, the way the reference rounds it.
fn elapsed(started: Instant) -> f64 {
    (started.elapsed().as_secs_f64() * 10_000.0).round() / 10.0
}

/// Where the request head ends, counting the blank line.
fn find_head_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|at| at + 4)
}

/// The method and target from the request line.
fn request_line(head: &[u8]) -> Option<(String, String)> {
    let line = head.split(|byte| *byte == b'\n').next()?;
    let text = String::from_utf8_lossy(line);
    let mut parts = text.trim_end().split(' ');
    Some((parts.next()?.to_string(), parts.next()?.to_string()))
}

/// The status code from a response head.
fn status_of(head: &[u8]) -> Option<u16> {
    let line = head.split(|byte| *byte == b'\n').next()?;
    String::from_utf8_lossy(line)
        .split(' ')
        .nth(1)?
        .parse()
        .ok()
}

/// Point `Host` at the upstream and ask it not to keep the connection alive.
///
/// Two rewrites, and only two. `Host` so a service that vhosts on it still
/// answers.
///
/// `Connection: close` is the load-bearing one: without it a keep-alive
/// upstream never closes, and since this proxy forwards bytes rather than
/// parsing HTTP it has no other way to know where one response ended — so the
/// request would be forwarded correctly and then never *reported*, which is the
/// entire point of the inspector. The cost is one connection per request while
/// the inspector is on, which is a throughput property of a debugging tool that
/// is off by default.
fn rewrite_head(head: &[u8], upstream_host: &str) -> Vec<u8> {
    let text = String::from_utf8_lossy(head);
    let mut out = String::with_capacity(text.len());
    let mut wrote_host = false;
    for line in text.split_inclusive("\r\n") {
        let trimmed = line.trim_end_matches("\r\n");
        if trimmed.is_empty() {
            if !wrote_host {
                out.push_str(&format!("host: {upstream_host}\r\n"));
                wrote_host = true;
            }
            out.push_str("connection: close\r\n");
            out.push_str(line);
            continue;
        }
        let name = trimmed.split(':').next().unwrap_or_default();
        if name.eq_ignore_ascii_case("host") {
            out.push_str(&format!("host: {upstream_host}\r\n"));
            wrote_host = true;
            continue;
        }
        // Dropped here and re-added at the blank line, so exactly one of each
        // goes up whatever the client sent.
        if name.eq_ignore_ascii_case("connection") || name.eq_ignore_ascii_case("keep-alive") {
            continue;
        }
        out.push_str(line);
    }
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_head_ends_at_the_blank_line() {
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\n\r\nbody"), Some(18));
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\nhost: x\r\n"), None);
    }

    #[test]
    fn the_request_line_gives_the_method_and_target() {
        assert_eq!(
            request_line(b"POST /a?b=1 HTTP/1.1\r\n"),
            Some(("POST".to_string(), "/a?b=1".to_string()))
        );
    }

    #[test]
    fn the_status_comes_off_the_response_line() {
        assert_eq!(
            status_of(b"HTTP/1.1 503 Service Unavailable\r\n"),
            Some(503)
        );
        assert_eq!(status_of(b"garbage\r\n"), None);
    }

    /// The host changes whatever case it arrived in, and nothing else does.
    #[test]
    fn the_host_is_pointed_upstream() {
        let head = b"GET / HTTP/1.1\r\nHost: example.test\r\nAccept: */*\r\n\r\n";
        let out = String::from_utf8(rewrite_head(head, "127.0.0.1:9000")).unwrap();
        assert!(out.contains("host: 127.0.0.1:9000\r\n"));
        assert!(!out.contains("example.test"));
        assert!(out.contains("Accept: */*\r\n"));
    }

    /// A request that arrived without one still gets one, because the upstream
    /// is entitled to a `Host` on HTTP/1.1.
    #[test]
    fn a_missing_host_is_added() {
        let head = b"GET / HTTP/1.1\r\nAccept: */*\r\n\r\n";
        let out = String::from_utf8(rewrite_head(head, "127.0.0.1:9000")).unwrap();
        assert!(out.contains("host: 127.0.0.1:9000\r\n"));
    }

    /// Exactly one `connection` header goes up, and it says close — whatever
    /// the client asked for. Without this the byte pipe cannot see where a
    /// response ended and no request is ever reported.
    #[test]
    fn the_upstream_is_asked_to_close() {
        let head =
            b"GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\n";
        let out = String::from_utf8(rewrite_head(head, "127.0.0.1:9000")).unwrap();
        assert_eq!(out.matches("connection: close").count(), 1);
        assert!(!out.to_lowercase().contains("keep-alive"));
        assert!(out.ends_with("connection: close\r\n\r\n"));
    }
}
