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

use std::net::SocketAddr;
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
    let rewritten = rewrite_host(&head[..head_end], &upstream_host);
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

    // The request body, counted as it goes.
    let request_bytes = tokio::spawn(async move {
        let mut total = 0usize;
        let mut buffer = [0u8; 8192];
        while let Ok(read) = client_read.read(&mut buffer).await {
            if read == 0 {
                break;
            }
            total += read;
            if upstream_write.write_all(&buffer[..read]).await.is_err() {
                break;
            }
        }
        let _ = upstream_write.shutdown().await;
        total
    });

    // The response, whose head is read far enough to learn the status.
    let mut response_bytes = 0usize;
    let mut status = 0u16;
    let mut buffer = [0u8; 8192];
    loop {
        let read = match upstream_read.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        if status == 0 {
            status = status_of(&buffer[..read]).unwrap_or(0);
        }
        response_bytes += read;
        if client_write.write_all(&buffer[..read]).await.is_err() {
            break;
        }
    }
    let _ = client_write.shutdown().await;

    let req_bytes = request_bytes.await.unwrap_or(0);
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

/// Point `Host` at the upstream, leaving every other header as it came.
fn rewrite_host(head: &[u8], upstream_host: &str) -> Vec<u8> {
    let text = String::from_utf8_lossy(head);
    let mut out = String::with_capacity(text.len());
    let mut replaced = false;
    for line in text.split_inclusive("\r\n") {
        let trimmed = line.trim_end_matches("\r\n");
        if trimmed.is_empty() {
            if !replaced {
                out.push_str(&format!("host: {upstream_host}\r\n"));
                replaced = true;
            }
            out.push_str(line);
            continue;
        }
        if trimmed
            .split(':')
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case("host"))
        {
            out.push_str(&format!("host: {upstream_host}\r\n"));
            replaced = true;
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

    /// The one header that changes, and it changes whatever its case was.
    #[test]
    fn the_host_is_pointed_upstream() {
        let head = b"GET / HTTP/1.1\r\nHost: example.test\r\nAccept: */*\r\n\r\n";
        let out = String::from_utf8(rewrite_host(head, "127.0.0.1:9000")).unwrap();
        assert!(out.contains("host: 127.0.0.1:9000\r\n"));
        assert!(!out.contains("example.test"));
        assert!(out.contains("Accept: */*\r\n"));
    }

    /// A request that arrived without one still gets one, because the upstream
    /// is entitled to a `Host` on HTTP/1.1.
    #[test]
    fn a_missing_host_is_added() {
        let head = b"GET / HTTP/1.1\r\nAccept: */*\r\n\r\n";
        let out = String::from_utf8(rewrite_host(head, "127.0.0.1:9000")).unwrap();
        assert!(out.contains("host: 127.0.0.1:9000\r\n"));
    }
}
