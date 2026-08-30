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

/// Vultr builds an instance with either `root` enabled or a sudo-capable
/// `linuxuser` instead, and says which through `user_scheme`. A target that
/// names the wrong one is a login that always fails.
const ROOT_USER: &str = "root";
const LIMITED_USER: &str = "linuxuser";
const LIMITED_SCHEME: &str = "limited";

/// The two spellings of "not assigned yet". Vultr reports an address it has not
/// given a machine as one of these rather than as nothing, for either family,
/// so neither is an address.
const UNASSIGNED: [&str; 2] = ["0.0.0.0", "::"];

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

/// A string field, absent when the vendor left it empty.
///
/// The vendor blanks `region`, `plan` and `os` on a machine it has not finished
/// placing, and an empty string in the answer would be reported by the
/// dashboard as a region whose name is nothing.
fn optional_text(raw: &Value, key: &str) -> Option<String> {
    let value = text(raw, key);
    (!value.is_empty()).then_some(value)
}

/// A size, absent when the vendor reports none — which it spells as a zero.
fn optional_number(raw: &Value, key: &str) -> Option<u64> {
    raw.get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value != 0)
}

/// One address, or nothing.
///
/// Shared by both families deliberately: the sentinels are the vendor's, not
/// IPv4's, and a v6 field carrying `::` means exactly what a v4 field carrying
/// `0.0.0.0` means.
fn address(raw: &Value, key: &str) -> Option<String> {
    let value = text(raw, key);
    let trimmed = value.trim();
    (!trimmed.is_empty() && !UNASSIGNED.contains(&trimmed)).then(|| trimmed.to_string())
}

/// The vendor's ISO timestamp as epoch milliseconds.
fn epoch_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

pub fn instance_from_raw(raw: &Value) -> HostInstance {
    let word = deciding_word(raw);
    let hostname = optional_text(raw, "hostname");
    let id = text(raw, "id");

    HostInstance {
        // A machine with no label is shown by the name it answers to, and one
        // with neither by its id — an empty row in the list is worse than a
        // technical one, and there is always an id.
        label: optional_text(raw, "label")
            .or_else(|| hostname.clone())
            .unwrap_or_else(|| id.clone()),
        id,
        state: state_of(&word),
        raw_state: word.clone(),
        ipv4: address(raw, "main_ip"),
        ipv6: address(raw, "v6_main_ip"),
        hostname,
        region: optional_text(raw, "region"),
        plan: optional_text(raw, "plan"),
        os: optional_text(raw, "os"),
        specs: HostInstanceSpecs {
            vcpus: optional_number(raw, "vcpu_count"),
            memory_mb: optional_number(raw, "ram"),
            disk_gb: optional_number(raw, "disk"),
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
        default_user: if text(raw, "user_scheme") == LIMITED_SCHEME {
            LIMITED_USER.into()
        } else {
            ROOT_USER.into()
        },
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
