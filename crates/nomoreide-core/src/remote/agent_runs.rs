//! Agent turns, as a phone sees them: numbered events, a short memory, and
//! approvals that deny themselves.
//!
//! **Every event carries a sequence number, and that number is the whole
//! resumption story.** A phone on a train loses its connection mid-turn; when
//! it comes back it says the last number it rendered and gets the rest. Order
//! is never inferred from arrival, because the relay is allowed to reorder and
//! one day will.
//!
//! The memory is deliberately short — [`limits::AGENT_EVENT_REPLAY_EVENTS`] and
//! [`limits::AGENT_EVENT_REPLAY_WINDOW`]. A phone that has been away longer
//! than that is told to start from a snapshot rather than handed a gap, because
//! a gap a client cannot see is a gap it renders as if nothing were missing.
//!
//! **Approvals fail closed, and there are four ways to arrive at "deny".** A
//! human says no; the timer runs out; the run ends; the daemon stops. Only the
//! first is a decision. The other three exist because a tool call blocked on a
//! phone that went into a pocket must not sit there holding an agent open, and
//! must certainly not proceed on the grounds that nobody objected.
//!
//! There is no "always allow" here and no `autoApprove`. Both exist locally,
//! where the person deciding is at the machine; neither is reachable from a
//! phone, because the whole point of the approval is that someone looked.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};

use super::protocol::agent_event::{
    AgentEvent, AgentEventBody, ApprovalDecider, ApprovalRequestEvent, ApprovalSettledEvent,
    ErrorEvent, NoData,
};
use super::protocol::device_bound::ApprovalVerdict;
use super::protocol::limits;

/// One turn in flight.
struct Run {
    /// The next sequence number to hand out.
    next_seq: u64,
    /// Recent events, oldest first, for a client that reconnects.
    history: Vec<(DateTime<Utc>, AgentEvent)>,
    /// Approvals waiting on a human, by approval id.
    pending: HashMap<String, PendingApproval>,
    finished: bool,
}

struct PendingApproval {
    expires_at: DateTime<Utc>,
    /// Wakes the blocked tool call with a verdict.
    decide: tokio::sync::oneshot::Sender<ApprovalVerdict>,
}

/// Why a resume could not be served from memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeGap {
    /// No such run — finished and forgotten, or never started here.
    UnknownRun,
    /// The run exists, but the events asked for are already gone.
    TooOld,
}

/// Every agent turn this daemon is running for a phone.
#[derive(Clone, Default)]
pub struct AgentRuns {
    runs: Arc<Mutex<HashMap<String, Run>>>,
}

impl AgentRuns {
    pub fn new() -> Self {
        Self::default()
    }

    /// Begin a run. Returns the sequence its first event will carry.
    pub fn open(&self, run_id: &str) -> u64 {
        let mut runs = self.runs.lock().expect("agent runs");
        let run = runs.entry(run_id.to_string()).or_insert_with(|| Run {
            next_seq: 0,
            history: Vec::new(),
            pending: HashMap::new(),
            finished: false,
        });
        run.next_seq
    }

    /// Number an event, remember it, and hand it back ready to send.
    ///
    /// Returns `None` for a run that is not open — an event for a finished run
    /// is dropped rather than renumbered into a new one, because a phone that
    /// saw `completed` must not then see more.
    pub fn emit(&self, run_id: &str, body: AgentEventBody) -> Option<AgentEvent> {
        let mut runs = self.runs.lock().expect("agent runs");
        let run = runs.get_mut(run_id)?;
        if run.finished {
            return None;
        }
        let terminal = body.terminal();
        let event = AgentEvent {
            run_id: run_id.to_string(),
            seq: run.next_seq,
            event: body,
        };
        run.next_seq += 1;
        run.history.push((Utc::now(), event.clone()));
        prune(&mut run.history);
        if terminal {
            run.finished = true;
        }
        Some(event)
    }

    /// Events after `seen`, for a client picking up where it left off.
    ///
    /// `None` means "I have seen nothing", which is a different question from
    /// `Some(0)` — that one means "I have seen event zero". A `u64` alone
    /// cannot tell those apart, and a phone opening a run for the first time
    /// asks the first question.
    pub fn resume(&self, run_id: &str, seen: Option<u64>) -> Result<Vec<AgentEvent>, ResumeGap> {
        let runs = self.runs.lock().expect("agent runs");
        let run = runs.get(run_id).ok_or(ResumeGap::UnknownRun)?;
        let wanted_from = seen.map(|seq| seq + 1).unwrap_or(0);
        // If the buffer already starts after the first event wanted, the ones
        // in between are gone, and saying so is the only honest answer.
        if let Some((_, oldest)) = run.history.first() {
            if oldest.seq > wanted_from {
                return Err(ResumeGap::TooOld);
            }
        }
        Ok(run
            .history
            .iter()
            .filter(|(_, event)| event.seq >= wanted_from)
            .map(|(_, event)| event.clone())
            .collect())
    }

    /// Park a tool call until a human decides, or something decides for them.
    ///
    /// Returns the event to send and the receiver the caller blocks on. The two
    /// are separate because the event has to reach the phone *before* anyone
    /// waits on the answer.
    pub fn open_approval(
        &self,
        run_id: &str,
        request: ApprovalRequestEvent,
    ) -> Option<(AgentEvent, tokio::sync::oneshot::Receiver<ApprovalVerdict>)> {
        let expires_at =
            Utc::now() + chrono::Duration::from_std(limits::APPROVAL_EXPIRY).expect("in range");
        let (decide, wait) = tokio::sync::oneshot::channel();
        let approval_id = request.approval_id.clone();
        let event = self.emit(run_id, AgentEventBody::ApprovalRequest(request))?;
        let mut runs = self.runs.lock().expect("agent runs");
        let run = runs.get_mut(run_id)?;
        run.pending
            .insert(approval_id, PendingApproval { expires_at, decide });
        Some((event, wait))
    }

    /// A human's decision.
    ///
    /// `None` when there is no such approval — already settled by a timer, or a
    /// second tap on a button that has already been pressed.
    pub fn settle_approval(
        &self,
        run_id: &str,
        approval_id: &str,
        verdict: ApprovalVerdict,
    ) -> Option<AgentEvent> {
        self.settle(run_id, approval_id, verdict, ApprovalDecider::User)
    }

    /// Deny everything whose timer has run out.
    ///
    /// Called on a tick. Returns the events to send, which is how a phone
    /// learns that the card it is still showing has expired.
    pub fn expire_approvals(&self, now: DateTime<Utc>) -> Vec<AgentEvent> {
        let expired: Vec<(String, String)> = {
            let runs = self.runs.lock().expect("agent runs");
            runs.iter()
                .flat_map(|(run_id, run)| {
                    run.pending
                        .iter()
                        .filter(|(_, pending)| pending.expires_at <= now)
                        .map(move |(approval_id, _)| (run_id.clone(), approval_id.clone()))
                })
                .collect()
        };
        expired
            .into_iter()
            .filter_map(|(run_id, approval_id)| {
                self.settle(
                    &run_id,
                    &approval_id,
                    ApprovalVerdict::Deny,
                    ApprovalDecider::Expiry,
                )
            })
            .collect()
    }

    /// End a run, denying anything still parked on it.
    ///
    /// The denial is the point. A tool call blocked on an approval whose run has
    /// gone would otherwise wait forever on a channel nobody holds.
    pub fn close(&self, run_id: &str) -> Vec<AgentEvent> {
        let approvals: Vec<String> = {
            let runs = self.runs.lock().expect("agent runs");
            match runs.get(run_id) {
                Some(run) => run.pending.keys().cloned().collect(),
                None => return Vec::new(),
            }
        };
        let mut events: Vec<AgentEvent> = approvals
            .into_iter()
            .filter_map(|approval_id| {
                self.settle(
                    run_id,
                    &approval_id,
                    ApprovalVerdict::Deny,
                    ApprovalDecider::Shutdown,
                )
            })
            .collect();
        if let Some(event) = self.emit(run_id, AgentEventBody::Cancelled(NoData {})) {
            events.push(event);
        }
        events
    }

    /// End every run. The daemon shutting down is the last of the four ways an
    /// approval reaches "deny".
    pub fn close_all(&self) -> Vec<AgentEvent> {
        let ids: Vec<String> = {
            let runs = self.runs.lock().expect("agent runs");
            runs.keys().cloned().collect()
        };
        ids.iter().flat_map(|run_id| self.close(run_id)).collect()
    }

    /// Forget runs that finished and have nothing left to replay.
    pub fn collect_finished(&self, now: DateTime<Utc>) {
        let window =
            chrono::Duration::from_std(limits::AGENT_EVENT_REPLAY_WINDOW).expect("in range");
        let mut runs = self.runs.lock().expect("agent runs");
        runs.retain(|_, run| {
            !run.finished
                || run
                    .history
                    .last()
                    .is_some_and(|(at, _)| now.signed_duration_since(*at) < window)
        });
    }

    pub fn is_running(&self, run_id: &str) -> bool {
        let runs = self.runs.lock().expect("agent runs");
        runs.get(run_id).is_some_and(|run| !run.finished)
    }

    fn settle(
        &self,
        run_id: &str,
        approval_id: &str,
        verdict: ApprovalVerdict,
        decided_by: ApprovalDecider,
    ) -> Option<AgentEvent> {
        let pending = {
            let mut runs = self.runs.lock().expect("agent runs");
            runs.get_mut(run_id)?.pending.remove(approval_id)?
        };
        // The blocked hook is woken before the event is emitted: a phone
        // learning the verdict slightly before the agent acts on it is
        // harmless, and the reverse would show a settled card while the tool
        // call was still parked.
        let _ = pending.decide.send(verdict);
        self.emit(
            run_id,
            AgentEventBody::ApprovalSettled(ApprovalSettledEvent {
                approval_id: approval_id.to_string(),
                verdict,
                decided_by,
            }),
        )
    }
}

/// Keep the buffer inside both bounds: how many, and how old.
fn prune(history: &mut Vec<(DateTime<Utc>, AgentEvent)>) {
    let cutoff = Utc::now()
        - chrono::Duration::from_std(limits::AGENT_EVENT_REPLAY_WINDOW).expect("in range");
    history.retain(|(at, _)| *at >= cutoff);
    if history.len() > limits::AGENT_EVENT_REPLAY_EVENTS {
        let excess = history.len() - limits::AGENT_EVENT_REPLAY_EVENTS;
        history.drain(..excess);
    }
}

/// Build the error event for a run that failed.
pub fn failure(message: impl Into<String>) -> AgentEventBody {
    AgentEventBody::Error(ErrorEvent {
        message: message.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::protocol::agent_event::TextEvent;
    use super::*;

    fn text(what: &str) -> AgentEventBody {
        AgentEventBody::Text(TextEvent { text: what.into() })
    }

    fn approval(id: &str) -> ApprovalRequestEvent {
        ApprovalRequestEvent {
            approval_id: id.into(),
            provider: "claude".into(),
            tool_name: "Bash".into(),
            input: serde_json::json!({ "command": "rm -rf build" }),
            workspace: "/w/project".into(),
            expires_at: Utc::now().to_rfc3339(),
        }
    }

    #[test]
    fn events_are_numbered_from_zero_without_gaps() {
        let runs = AgentRuns::new();
        runs.open("run_1");

        let seqs: Vec<u64> = (0..5)
            .map(|n| {
                runs.emit("run_1", text(&n.to_string()))
                    .expect("emitted")
                    .seq
            })
            .collect();

        assert_eq!(seqs, [0, 1, 2, 3, 4]);
    }

    /// Opening a run for the first time is a different question from resuming
    /// one, and both have to be askable.
    #[test]
    fn a_phone_that_has_seen_nothing_gets_everything() {
        let runs = AgentRuns::new();
        runs.open("run_1");
        for n in 0..3 {
            runs.emit("run_1", text(&n.to_string()));
        }

        let all = runs.resume("run_1", None).expect("resumable");

        assert_eq!(
            all.iter().map(|event| event.seq).collect::<Vec<_>>(),
            [0, 1, 2]
        );
    }

    #[test]
    fn a_phone_resumes_from_the_number_it_last_saw() {
        let runs = AgentRuns::new();
        runs.open("run_1");
        for n in 0..5 {
            runs.emit("run_1", text(&n.to_string()));
        }

        let rest = runs.resume("run_1", Some(2)).expect("resumable");

        assert_eq!(
            rest.iter().map(|event| event.seq).collect::<Vec<_>>(),
            [3, 4]
        );
    }

    #[test]
    fn resuming_a_run_nobody_started_says_so() {
        assert_eq!(
            AgentRuns::new().resume("ghost", None),
            Err(ResumeGap::UnknownRun)
        );
    }

    /// The case that must never be answered with silence: a phone away longer
    /// than the buffer asks for events that are gone.
    #[test]
    fn a_resume_past_the_buffer_is_a_gap_rather_than_an_empty_answer() {
        let runs = AgentRuns::new();
        runs.open("run_1");
        for n in 0..(limits::AGENT_EVENT_REPLAY_EVENTS + 50) {
            runs.emit("run_1", text(&n.to_string()));
        }

        // Asking from the very beginning, long since evicted.
        assert_eq!(runs.resume("run_1", None), Err(ResumeGap::TooOld));
        // Asking from inside the buffer still works.
        let recent = runs
            .resume(
                "run_1",
                Some((limits::AGENT_EVENT_REPLAY_EVENTS + 40) as u64),
            )
            .expect("recent events survive");
        assert_eq!(recent.len(), 9);
    }

    #[test]
    fn a_finished_run_emits_nothing_more() {
        let runs = AgentRuns::new();
        runs.open("run_1");
        runs.emit("run_1", AgentEventBody::Completed(NoData {}));

        assert!(runs.emit("run_1", text("after the end")).is_none());
        assert!(!runs.is_running("run_1"));
    }

    #[tokio::test]
    async fn a_human_can_allow_a_tool_call() {
        let runs = AgentRuns::new();
        runs.open("run_1");
        let (event, wait) = runs
            .open_approval("run_1", approval("ap_1"))
            .expect("opened");
        assert!(matches!(event.event, AgentEventBody::ApprovalRequest(_)));

        let settled = runs
            .settle_approval("run_1", "ap_1", ApprovalVerdict::Allow)
            .expect("settled");

        assert_eq!(wait.await.expect("verdict"), ApprovalVerdict::Allow);
        let AgentEventBody::ApprovalSettled(body) = settled.event else {
            panic!("expected a settlement");
        };
        assert_eq!(body.decided_by, ApprovalDecider::User);
    }

    /// A phone that went into a pocket must not hold an agent open, and must
    /// certainly not be taken to have agreed.
    #[tokio::test]
    async fn an_unanswered_approval_denies_itself() {
        let runs = AgentRuns::new();
        runs.open("run_1");
        let (_, wait) = runs
            .open_approval("run_1", approval("ap_1"))
            .expect("opened");

        let expired = runs.expire_approvals(
            Utc::now() + chrono::Duration::from_std(limits::APPROVAL_EXPIRY).expect("in range"),
        );

        assert_eq!(expired.len(), 1);
        assert_eq!(wait.await.expect("verdict"), ApprovalVerdict::Deny);
        let AgentEventBody::ApprovalSettled(body) = &expired[0].event else {
            panic!("expected a settlement");
        };
        assert_eq!(body.decided_by, ApprovalDecider::Expiry);
    }

    #[tokio::test]
    async fn an_approval_that_has_not_expired_is_left_alone() {
        let runs = AgentRuns::new();
        runs.open("run_1");
        let (_, _wait) = runs
            .open_approval("run_1", approval("ap_1"))
            .expect("opened");

        assert!(runs.expire_approvals(Utc::now()).is_empty());
    }

    /// The third way to deny: the run ends first.
    #[tokio::test]
    async fn closing_a_run_denies_what_is_still_parked_on_it() {
        let runs = AgentRuns::new();
        runs.open("run_1");
        let (_, wait) = runs
            .open_approval("run_1", approval("ap_1"))
            .expect("opened");

        let events = runs.close("run_1");

        assert_eq!(wait.await.expect("verdict"), ApprovalVerdict::Deny);
        let settled = events
            .iter()
            .find_map(|event| match &event.event {
                AgentEventBody::ApprovalSettled(body) => Some(body),
                _ => None,
            })
            .expect("a settlement");
        assert_eq!(settled.decided_by, ApprovalDecider::Shutdown);
        assert!(!runs.is_running("run_1"));
    }

    /// And the fourth: the daemon stops.
    #[tokio::test]
    async fn shutting_down_denies_every_parked_approval() {
        let runs = AgentRuns::new();
        for run_id in ["run_1", "run_2"] {
            runs.open(run_id);
            runs.open_approval(run_id, approval("ap")).expect("opened");
        }

        let events = runs.close_all();

        let denials = events
            .iter()
            .filter(|event| matches!(event.event, AgentEventBody::ApprovalSettled(_)))
            .count();
        assert_eq!(denials, 2);
    }

    /// Two taps on one button must not settle twice.
    #[tokio::test]
    async fn settling_the_same_approval_twice_answers_once() {
        let runs = AgentRuns::new();
        runs.open("run_1");
        runs.open_approval("run_1", approval("ap_1"))
            .expect("opened");

        assert!(runs
            .settle_approval("run_1", "ap_1", ApprovalVerdict::Allow)
            .is_some());
        assert!(runs
            .settle_approval("run_1", "ap_1", ApprovalVerdict::Allow)
            .is_none());
    }

    #[test]
    fn a_finished_run_is_forgotten_once_nothing_can_replay_it() {
        let runs = AgentRuns::new();
        runs.open("run_1");
        runs.emit("run_1", AgentEventBody::Completed(NoData {}));

        runs.collect_finished(Utc::now());
        assert_eq!(runs.resume("run_1", None).map(|events| events.len()), Ok(1));

        let later = Utc::now()
            + chrono::Duration::from_std(limits::AGENT_EVENT_REPLAY_WINDOW).expect("in range")
            + chrono::Duration::seconds(1);
        runs.collect_finished(later);
        assert_eq!(runs.resume("run_1", None), Err(ResumeGap::UnknownRun));
    }

    /// An unfinished run is never collected, however quiet it has been.
    #[test]
    fn a_live_run_survives_collection() {
        let runs = AgentRuns::new();
        runs.open("run_1");
        runs.emit("run_1", text("still going"));

        runs.collect_finished(Utc::now() + chrono::Duration::hours(1));

        assert!(runs.is_running("run_1"));
    }
}

/// Translate one local agent-stream event into its remote counterpart.
///
/// A pure function, and the whole of what the two vocabularies have to agree
/// about. Three of the local events have no remote form and return `None`:
///
/// - `session`, which carries the provider's own session id — an identifier for
///   a thing on this machine, useful to nothing holding a phone;
/// - a tool result's `name`, dropped because the phone already saw the
///   `toolUse` that names it;
/// - anything a newer provider emits that this build has never heard of.
///
/// `ApprovalRequest` is deliberately *not* handled here. It needs a workspace,
/// a provider and an expiry that only the caller knows, and building it from a
/// stream event alone would mean guessing at the three fields the approval card
/// exists to show.
pub fn from_stream_event(event: &crate::agent_runtime::AgentStreamEvent) -> Option<AgentEventBody> {
    use super::protocol::agent_event::{TextEvent, ToolResultEvent, ToolUseEvent};
    use crate::agent_runtime::AgentStreamEvent as Local;

    Some(match event {
        Local::Text { text } => AgentEventBody::Text(TextEvent { text: text.clone() }),
        Local::ToolUse { id, name, input } => AgentEventBody::ToolUse(ToolUseEvent {
            tool_use_id: id.clone(),
            name: name.clone(),
            input: input.clone(),
        }),
        Local::ToolResult {
            id,
            preview,
            is_error,
            ..
        } => AgentEventBody::ToolResult(ToolResultEvent {
            tool_use_id: id.clone(),
            ok: !is_error,
            // `preview` is already the bounded summary the local UI shows. A
            // tool result can be a whole file, and the remote surface does not
            // carry file contents.
            summary: preview.clone(),
        }),
        Local::Done { .. } => AgentEventBody::Completed(NoData {}),
        Local::Error { message } => failure(message.clone()),
        // Local-only, and the approval, which the caller builds.
        Local::Session { .. } | Local::ApprovalRequest { .. } => return None,
    })
}

#[cfg(test)]
mod translation_tests {
    use super::*;
    use crate::agent_runtime::AgentStreamEvent as Local;

    #[test]
    fn text_tool_use_and_tool_result_cross_over() {
        let text = from_stream_event(&Local::Text {
            text: "hello".into(),
        })
        .expect("text");
        assert!(matches!(text, AgentEventBody::Text(body) if body.text == "hello"));

        let use_event = from_stream_event(&Local::ToolUse {
            id: "tu_1".into(),
            name: "Bash".into(),
            input: serde_json::json!({ "command": "ls" }),
        })
        .expect("tool use");
        assert_eq!(use_event.kind(), "toolUse");

        let result = from_stream_event(&Local::ToolResult {
            id: "tu_1".into(),
            name: "Bash".into(),
            preview: "3 files".into(),
            is_error: false,
        })
        .expect("tool result");
        let AgentEventBody::ToolResult(body) = result else {
            panic!("expected a tool result");
        };
        assert!(body.ok);
        assert_eq!(body.summary, "3 files");
    }

    /// `is_error` inverts into `ok`. Getting this backwards would paint every
    /// failure green.
    #[test]
    fn a_failed_tool_result_is_not_ok() {
        let result = from_stream_event(&Local::ToolResult {
            id: "tu_1".into(),
            name: "Bash".into(),
            preview: "exit 1".into(),
            is_error: true,
        })
        .expect("tool result");

        let AgentEventBody::ToolResult(body) = result else {
            panic!("expected a tool result");
        };
        assert!(!body.ok);
    }

    #[test]
    fn done_and_error_are_the_two_endings() {
        assert!(from_stream_event(&Local::Done { stop_reason: None })
            .expect("done")
            .terminal());
        assert!(from_stream_event(&Local::Error {
            message: "boom".into()
        })
        .expect("error")
        .terminal());
    }

    /// The provider's session id identifies something on this machine. A phone
    /// has no use for it, so it does not travel.
    #[test]
    fn the_session_event_does_not_cross_over() {
        assert!(from_stream_event(&Local::Session {
            session_id: "abc".into()
        })
        .is_none());
    }

    /// Built by the caller, which is the only place the workspace and provider
    /// are known.
    #[test]
    fn an_approval_request_is_left_to_the_caller() {
        assert!(from_stream_event(&Local::ApprovalRequest {
            request_id: "ap_1".into(),
            name: "Bash".into(),
            input: serde_json::Value::Null,
        })
        .is_none());
    }
}
