//! What happens when the same request id arrives twice.
//!
//! The rule that matters is the one about *not* retrying. The dangerous failure
//! in remote machine control is not a command that fails — it is a command that
//! ran, answered nothing because the socket died, and gets sent again by
//! something helpful. `restart the database` twice is a different outcome from
//! `restart the database` once, and no amount of care at the call site prevents
//! it if the transport is allowed to be helpful.
//!
//! So: **the request id is the idempotency key**, a mutation executes at most
//! once per id, and no layer of this system automatically re-sends a mutation
//! whose outcome it does not know. Ambiguity is escalated to a human looking at
//! the machine's real state, which is exactly what a phone is good for.
//!
//! Reads are exempt. Re-asking for a service list is free, and pretending
//! otherwise would mean a phone that scrolled back could not refresh.

use super::device_bound::DeviceBound;

/// What to do with a frame whose id has been seen before inside
/// [`super::limits::REQUEST_ID_DEDUP_WINDOW`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Run it. Either the id is new, or the command is a read and repeating it
    /// costs nothing.
    Execute,
    /// The first attempt finished and its answer is still held. Send that
    /// answer again rather than doing the work twice.
    ReplayRecordedResponse,
    /// The first attempt is still running. Refuse — two answers to one id is
    /// worse than one refusal, because the caller cannot tell them apart.
    Refuse,
}

/// Whether a repeat of this command may simply run again.
///
/// Reads may; mutations may not. Written against the command rather than a
/// per-call flag so that adding a variant to the union forces the question to
/// be answered in [`DeviceBound::mutating`], where it is visible.
pub fn repeatable(command: &DeviceBound) -> bool {
    !command.mutating()
}

/// The state a ledger holds about an id it has already seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seen {
    /// Never seen inside the window.
    Never,
    /// Seen, and still running.
    InFlight,
    /// Seen, finished, and the answer is still cached.
    Answered,
    /// Seen and finished, but the answer is gone — evicted, or the process
    /// restarted.
    AnswerLost,
}

/// The whole rule, as one function.
///
/// A pure decision so it can be tested exhaustively without a ledger, a socket
/// or a clock; the ledger that supplies [`Seen`] arrives with the connector.
pub fn decide(command: &DeviceBound, seen: Seen) -> Disposition {
    match seen {
        Seen::Never => Disposition::Execute,
        _ if repeatable(command) => Disposition::Execute,
        Seen::InFlight => Disposition::Refuse,
        Seen::Answered => Disposition::ReplayRecordedResponse,
        // The worst case, and the reason it refuses rather than re-running: the
        // command definitely executed, and this end no longer knows what
        // happened. Running it again would be the double mutation.
        Seen::AnswerLost => Disposition::Refuse,
    }
}

#[cfg(test)]
mod tests {
    use super::super::device_bound::{Empty, ServiceAction, ServiceActionRequest};
    use super::*;

    fn a_read() -> DeviceBound {
        DeviceBound::ServiceList(Empty {})
    }

    fn a_mutation() -> DeviceBound {
        DeviceBound::ServiceAction(ServiceActionRequest {
            service: "api".into(),
            action: ServiceAction::Restart,
        })
    }

    #[test]
    fn a_read_always_runs_however_often_it_arrives() {
        for seen in [
            Seen::Never,
            Seen::InFlight,
            Seen::Answered,
            Seen::AnswerLost,
        ] {
            assert_eq!(decide(&a_read(), seen), Disposition::Execute);
        }
    }

    #[test]
    fn a_first_mutation_runs() {
        assert_eq!(decide(&a_mutation(), Seen::Never), Disposition::Execute);
    }

    /// The three cases that must never be `Execute`. If any of them ever is, a
    /// phone with a flaky connection can restart a service twice.
    #[test]
    fn a_repeated_mutation_never_runs_again() {
        for seen in [Seen::InFlight, Seen::Answered, Seen::AnswerLost] {
            assert_ne!(
                decide(&a_mutation(), seen),
                Disposition::Execute,
                "{seen:?} re-executed a mutation"
            );
        }
    }

    #[test]
    fn a_finished_mutation_replays_its_answer() {
        assert_eq!(
            decide(&a_mutation(), Seen::Answered),
            Disposition::ReplayRecordedResponse
        );
    }

    /// A lost answer is the ambiguous case, and ambiguity refuses.
    #[test]
    fn a_mutation_whose_answer_is_gone_refuses() {
        assert_eq!(decide(&a_mutation(), Seen::AnswerLost), Disposition::Refuse);
    }

    /// Every command in the union is classified, and the classification agrees
    /// with the union's own `mutating`. This is the link that keeps a new
    /// variant from defaulting to "repeatable" by omission.
    #[test]
    fn repeatable_is_exactly_the_non_mutating_half() {
        for command in super::super::fixtures::every_command() {
            assert_eq!(
                repeatable(&command),
                !command.mutating(),
                "{}",
                command.kind()
            );
        }
    }
}
