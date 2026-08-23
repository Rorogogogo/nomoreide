//! Vultr as host provider #1.
//!
//! The Rust half of `src/core/vultr-provider.ts`. Everything vendor-specific
//! about a Vultr machine stops here: the caller above sees only the neutral
//! `HostInstance`.

use crate::providers::api_base::provider_api_host;
use crate::providers::host::{HostInstance, HostInstanceSpecs, HostInstanceState};
use crate::vultr_manager::api_base;
use serde_json::Value;

pub const VULTR_ACTIONS: &[&str] = &["start", "halt", "reboot"];

/// The two actions that stop a machine that may be serving something. The
/// dashboard asks before running one; `start` needs no such question.
pub const PRODUCTION_AFFECTING_ACTIONS: &[&str] = &["halt", "reboot"];

/// The images Vultr offers all land on `root`.
const DEFAULT_USER: &str = "root";

/// Vultr reports an address it has not assigned yet as this rather than as
/// nothing, so it is not an address.
const UNASSIGNED_IPV4: &str = "0.0.0.0";

/// The one vendor word that decides a machine's state.
///
/// Vultr spreads the answer over three fields, and at any moment exactly one of
/// them is the deciding one. The subscription's own lifecycle outranks
/// everything — a suspended machine still reports `power_status: "running"`,
/// and showing that as running would be a lie. Once the subscription is
/// `active`, a machine mid-install or locked is not yet usable whatever its
/// power says. Power is the last word rather than the first.
///
/// Only `installingbooting` and `locked` are deciding server states; anything
/// else there, `none` included, falls through to power.
fn deciding_word(raw: &Value) -> String {
    let status = text(raw, "status");
    if status != "active" {
        return status;
    }
    match text(raw, "server_status").as_str() {
        // The vendor's own word is `installingbooting`; the one reported is the
        // half a person reads.
        "installingbooting" => "installing".to_string(),
        "locked" => "locked".to_string(),
        _ => text(raw, "power_status"),
    }
}

/// That word onto the five neutral states.
///
/// An unrecognised word is `Unknown` rather than a guess: the alternative is a
/// dashboard that confidently says "running" about a machine nobody classified.
/// `raw_state` carries the word itself, so the UI can say what it did not know.
pub fn state_of(word: &str) -> HostInstanceState {
    match word {
        "running" => HostInstanceState::Running,
        "stopped" => HostInstanceState::Stopped,
        "installing" | "locked" | "pending" | "resizing" => HostInstanceState::Provisioning,
        "suspended" => HostInstanceState::Error,
        _ => HostInstanceState::Unknown,
    }
}

fn text(raw: &Value, key: &str) -> String {
    raw.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn number(raw: &Value, key: &str) -> u64 {
    raw.get(key).and_then(Value::as_u64).unwrap_or_default()
}

/// The vendor's ISO timestamp as epoch milliseconds.
fn epoch_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

pub fn instance_from_raw(raw: &Value) -> HostInstance {
    let word = deciding_word(raw);
    let hostname = text(raw, "hostname");
    let hostname = (!hostname.is_empty()).then_some(hostname);
    let label = text(raw, "label");
    let ipv4 = text(raw, "main_ip");

    HostInstance {
        id: text(raw, "id"),
        // A machine with no label is shown by the name it answers to, because
        // an empty row in the list is worse than a technical one.
        label: if label.is_empty() {
            hostname.clone().unwrap_or_default()
        } else {
            label
        },
        state: state_of(&word),
        raw_state: word.clone(),
        ipv4: (!ipv4.is_empty() && ipv4 != UNASSIGNED_IPV4).then_some(ipv4),
        hostname,
        region: text(raw, "region"),
        plan: text(raw, "plan"),
        os: text(raw, "os"),
        specs: HostInstanceSpecs {
            vcpus: number(raw, "vcpu_count"),
            memory_mb: number(raw, "ram"),
            disk_gb: number(raw, "disk"),
        },
        tags: raw
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        created_at: epoch_ms(&text(raw, "date_created")),
        default_user: DEFAULT_USER.into(),
    }
}

/// The manifest the dashboard renders a tab from.
pub fn manifest() -> Value {
    serde_json::json!({
        "id": crate::vultr_auth::VULTR_PROVIDER_ID,
        "name": "Vultr",
        "kind": "host",
        "strings": {
            "en": {
                "action.start": "Start",
                "action.start.done": "Instance starting.",
                "action.halt": "Stop",
                "action.halt.done": "Instance stopping.",
                "action.halt.confirmTitle": "Stop this instance?",
                "action.halt.confirm": "The machine powers off immediately. Anything running on it stops.",
                "action.reboot": "Reboot",
                "action.reboot.done": "Instance rebooting.",
                "action.reboot.confirmTitle": "Reboot this instance?",
                "action.reboot.confirm": "The machine restarts immediately. Anything running on it stops."
            },
            "zh": {
                "action.start": "启动",
                "action.start.done": "实例正在启动。",
                "action.halt": "停止",
                "action.halt.done": "实例正在停止。",
                "action.halt.confirmTitle": "停止该实例？",
                "action.halt.confirm": "机器将立即关机，其上运行的一切都会停止。",
                "action.reboot": "重启",
                "action.reboot.done": "实例正在重启。",
                "action.reboot.confirmTitle": "重启该实例？",
                "action.reboot.confirm": "机器将立即重启，其上运行的一切都会停止。"
            }
        },
        "actions": VULTR_ACTIONS,
        "productionAffecting": PRODUCTION_AFFECTING_ACTIONS,
        // The API only. An adopted instance is reached over SSH by its own
        // transport, which never goes through this fetch — so no instance
        // address belongs here.
        "api": { "hosts": [provider_api_host(&api_base())] },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn word(status: &str, power: &str, server: &str) -> String {
        deciding_word(&json!({
            "status": status, "power_status": power, "server_status": server
        }))
    }

    #[test]
    fn the_subscription_outranks_the_power_field() {
        assert_eq!(word("suspended", "running", "ok"), "suspended");
        assert_eq!(state_of("suspended"), HostInstanceState::Error);
        assert_eq!(word("pending", "stopped", "none"), "pending");
    }

    #[test]
    fn a_machine_still_installing_or_locked_is_not_running() {
        assert_eq!(word("active", "running", "installingbooting"), "installing");
        assert_eq!(word("active", "running", "locked"), "locked");
        assert_eq!(state_of("installing"), HostInstanceState::Provisioning);
    }

    /// Everything else a server status can say falls through to power — `none`
    /// included, which is what a machine that finished installing reports.
    #[test]
    fn any_other_server_state_defers_to_power() {
        assert_eq!(word("active", "running", "none"), "running");
        assert_eq!(word("active", "running", "something_new"), "running");
        assert_eq!(word("active", "stopped", "ok"), "stopped");
    }

    #[test]
    fn an_unmapped_word_is_unknown_rather_than_a_guess() {
        assert_eq!(word("something_new", "running", "ok"), "something_new");
        assert_eq!(state_of("something_new"), HostInstanceState::Unknown);
        assert_eq!(word("active", "something_new", "ok"), "something_new");
    }

    #[test]
    fn an_unassigned_address_is_not_an_address() {
        let raw = json!({ "id": "i", "main_ip": "0.0.0.0", "hostname": "h" });
        assert_eq!(instance_from_raw(&raw).ipv4, None);
    }

    #[test]
    fn a_blank_label_falls_back_to_the_hostname() {
        let raw = json!({ "id": "i", "label": "", "hostname": "box.example.test" });
        assert_eq!(instance_from_raw(&raw).label, "box.example.test");
    }
}
