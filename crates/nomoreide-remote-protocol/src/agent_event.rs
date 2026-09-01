//! What one agent turn emits, in order.
//!
//! Every event carries a `seq` that is monotonic within its run and starts at
//! `0`. That number is the whole resumption story: a phone that reconnects
//! sends the last `seq` it rendered and gets the rest, and a phone whose `seq`
//! is older than the daemon's replay buffer is told to take a fresh snapshot
//! rather than handed a gap it cannot detect. Ordering is never inferred from
//! arrival — the relay is allowed to reorder, and one day will.
//!
//! Approvals are the security-critical member of this union. The remote policy
//! is fail-closed and stated once, here, so no later reader has to reconstruct
//! it: `autoApprove` does not exist remotely, an approval that is not answered
//! within [`super::limits::APPROVAL_EXPIRY`] denies itself, a run that ends
//! denies everything still pending, an unknown tool is treated as mutating, and
//! there is no "always allow".
//!
//! The body is nested under `event` rather than flattened onto the envelope
//! because serde cannot combine `flatten` with `deny_unknown_fields`, and of
//! the two, strictness is the one worth keeping: a flat shape reads slightly
//! better and silently tolerates every field nobody meant to send.

use serde::{Deserialize, Serialize};

/// One event in a run, with its place in the sequence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentEvent {
    pub run_id: String,
    /// Monotonic within the run, from `0`, no gaps.
    pub seq: u64,
    pub event: AgentEventBody,
}

/// The event itself, adjacently tagged so every variant's body can be a named
/// struct that refuses fields it does not define.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum AgentEventBody {
    /// A chunk of assistant text. Already stripped of ANSI and control bytes.
    Text(TextEvent),
    /// The agent is about to call a tool. Emitted whether or not the call needs
    /// approval, so the phone can show what happened either way.
    ToolUse(ToolUseEvent),
    /// How that call went.
    ToolResult(ToolResultEvent),
    /// A mutating tool call is blocked on a human.
    ApprovalRequest(ApprovalRequestEvent),
    /// The approval was settled — by a human, or by the daemon denying it.
    ApprovalSettled(ApprovalSettledEvent),
    /// The turn finished normally.
    Completed(NoData),
    /// The turn was cancelled — by the phone, or because the daemon stopped.
    Cancelled(NoData),
    /// The turn failed. Prose for a human; never a stack trace, never a path.
    Error(ErrorEvent),
}

/// An event body with nothing in it. Present as `{}` rather than absent, for
/// the same reason [`super::device_bound::Empty`] is.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoData {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextEvent {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolUseEvent {
    pub tool_use_id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// `summary` is bounded prose, never the raw result: a tool result can be a
/// whole file, and the remote surface does not carry file contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResultEvent {
    pub tool_use_id: String,
    pub ok: bool,
    pub summary: String,
}

/// Everything the approval card must show.
///
/// `input` is the **full** structured input on purpose. A summary is what lets
/// a hostile prompt get a destructive call approved by making it look boring.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalRequestEvent {
    pub approval_id: String,
    pub provider: String,
    pub tool_name: String,
    pub input: serde_json::Value,
    /// The workspace the call would run in, so the human knows *which* checkout
    /// they are about to let it touch.
    pub workspace: String,
    /// RFC 3339, UTC. After this the daemon denies on its own.
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalSettledEvent {
    pub approval_id: String,
    pub verdict: super::device_bound::ApprovalVerdict,
    pub decided_by: ApprovalDecider,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorEvent {
    pub message: String,
}

/// Who settled an approval: a human, the expiry timer, or teardown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecider {
    User,
    Expiry,
    Shutdown,
}

impl AgentEventBody {
    /// Whether this event ends the run. A phone stops expecting more after one
    /// of these, and the daemon frees the run's replay buffer.
    pub fn terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed(_) | Self::Cancelled(_) | Self::Error(_)
        )
    }

    /// The wire spelling of `kind`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Text(_) => "text",
            Self::ToolUse(_) => "toolUse",
            Self::ToolResult(_) => "toolResult",
            Self::ApprovalRequest(_) => "approvalRequest",
            Self::ApprovalSettled(_) => "approvalSettled",
            Self::Completed(_) => "completed",
            Self::Cancelled(_) => "cancelled",
            Self::Error(_) => "error",
        }
    }

    /// Every event kind a v1 run may emit.
    pub const KINDS: &'static [&'static str] = &[
        "text",
        "toolUse",
        "toolResult",
        "approvalRequest",
        "approvalSettled",
        "completed",
        "cancelled",
        "error",
    ];
}

#[cfg(test)]
mod tests {
    use super::super::device_bound::ApprovalVerdict;
    use super::*;

    #[test]
    fn an_event_carries_its_run_and_sequence_beside_the_body() {
        let event = AgentEvent {
            run_id: "run_1".into(),
            seq: 7,
            event: AgentEventBody::Text(TextEvent {
                text: "hello".into(),
            }),
        };
        let json = serde_json::to_value(&event).expect("serialise");
        assert_eq!(json["runId"], "run_1");
        assert_eq!(json["seq"], 7);
        assert_eq!(json["event"]["kind"], "text");
        assert_eq!(json["event"]["data"]["text"], "hello");
    }

    #[test]
    fn an_approval_request_round_trips_with_its_full_input() {
        let event = AgentEvent {
            run_id: "run_1".into(),
            seq: 0,
            event: AgentEventBody::ApprovalRequest(ApprovalRequestEvent {
                approval_id: "ap_1".into(),
                provider: "claude".into(),
                tool_name: "Bash".into(),
                input: serde_json::json!({ "command": "rm -rf build" }),
                workspace: "/w/project".into(),
                expires_at: "2026-09-01T00:02:00Z".into(),
            }),
        };
        let json = serde_json::to_string(&event).expect("serialise");
        let back: AgentEvent = serde_json::from_str(&json).expect("parse");
        assert_eq!(back, event);
    }

    #[test]
    fn only_the_three_endings_are_terminal() {
        assert!(AgentEventBody::Completed(NoData {}).terminal());
        assert!(AgentEventBody::Cancelled(NoData {}).terminal());
        assert!(AgentEventBody::Error(ErrorEvent {
            message: "boom".into()
        })
        .terminal());
        assert!(!AgentEventBody::Text(TextEvent { text: "x".into() }).terminal());
        assert!(!AgentEventBody::ApprovalSettled(ApprovalSettledEvent {
            approval_id: "ap_1".into(),
            verdict: ApprovalVerdict::Deny,
            decided_by: ApprovalDecider::Expiry,
        })
        .terminal());
    }

    /// A terminal event kind the remote surface deliberately does not have. If
    /// this ever parses, raw terminal output has reached the wire.
    #[test]
    fn an_unknown_event_kind_is_refused() {
        let refused = serde_json::from_str::<AgentEvent>(
            r#"{"runId":"run_1","seq":0,"event":{"kind":"terminalOutput","data":{}}}"#,
        );
        assert!(refused.is_err());
    }

    #[test]
    fn kinds_matches_the_union() {
        let bodies = [
            AgentEventBody::Text(TextEvent {
                text: String::new(),
            }),
            AgentEventBody::ToolUse(ToolUseEvent {
                tool_use_id: String::new(),
                name: String::new(),
                input: serde_json::Value::Null,
            }),
            AgentEventBody::ToolResult(ToolResultEvent {
                tool_use_id: String::new(),
                ok: true,
                summary: String::new(),
            }),
            AgentEventBody::ApprovalRequest(ApprovalRequestEvent {
                approval_id: String::new(),
                provider: String::new(),
                tool_name: String::new(),
                input: serde_json::Value::Null,
                workspace: String::new(),
                expires_at: String::new(),
            }),
            AgentEventBody::ApprovalSettled(ApprovalSettledEvent {
                approval_id: String::new(),
                verdict: ApprovalVerdict::Allow,
                decided_by: ApprovalDecider::User,
            }),
            AgentEventBody::Completed(NoData {}),
            AgentEventBody::Cancelled(NoData {}),
            AgentEventBody::Error(ErrorEvent {
                message: String::new(),
            }),
        ];
        let kinds: Vec<&str> = bodies.iter().map(AgentEventBody::kind).collect();
        assert_eq!(kinds, AgentEventBody::KINDS);
    }
}
