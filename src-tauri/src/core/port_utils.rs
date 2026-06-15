use std::net::TcpStream;
use std::time::Duration;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBindingStatus {
    pub port: u16,
    pub available: bool,
    pub bindings: Vec<PortBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBinding {
    pub host: String,
    pub port: u16,
    pub bound: bool,
}

pub fn is_port_available(host: &str, port: u16) -> bool {
    !check_host_port(host, port)
}

pub fn check_host_port(host: &str, port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("{host}:{port}").parse().unwrap_or_else(|_| {
            format!("127.0.0.1:{port}").parse().unwrap()
        }),
        Duration::from_millis(200),
    ).is_ok()
}

pub fn get_port_binding_status(port: u16) -> PortBindingStatus {
    let hosts = ["127.0.0.1", "localhost", "0.0.0.0"];
    let bindings: Vec<PortBinding> = hosts
        .iter()
        .map(|h| PortBinding {
            host: h.to_string(),
            port,
            bound: check_host_port(h, port),
        })
        .collect();
    let available = bindings.iter().all(|b| !b.bound);
    PortBindingStatus { port, available, bindings }
}
