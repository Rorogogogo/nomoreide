//! Attaching this daemon to the relay, if the machine has been paired.
//!
//! The connector lives in `nomoreide-core`; what lives here is the decision to
//! start one, and what it does with a command when it arrives.
//!
//! **Only the machine-global daemon connects.** The desktop app runs its own
//! daemon in-process on a private port, and if both dialled in with the same
//! credential the relay would keep whichever connected last — so a phone would
//! be talking to whichever of the user's two daemons had most recently
//! restarted, which is nobody's idea of a machine. The one that owns the
//! runtime lock is the one that speaks for the machine.

pub(crate) mod dispatcher;
pub(crate) mod supervisor;
pub(crate) mod terminal;

/// Whether the environment says not to connect.
///
/// Any value except `0` and `false` counts as set, because the common mistake
/// is `NOMOREIDE_REMOTE_DISABLED=1` meaning "off" and the second-commonest is
/// `=true`. A switch whose safe position is hard to reach is not a switch.
/// Whether this machine will hand a phone a **shell**.
///
/// On by default, and switchable, because it is the one remote capability that
/// is genuinely arbitrary command execution. `NOMOREIDE_REMOTE_SHELL=0` turns
/// it off; the machine then advertises no shell capability at all, so a phone
/// is never shown a button it would be refused for pressing.
pub(crate) fn shell_allowed() -> bool {
    std::env::var("NOMOREIDE_REMOTE_SHELL")
        .map(|value| {
            !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "no" | "off"
            )
        })
        .unwrap_or(true)
}

pub(crate) fn disabled_by_environment() -> bool {
    std::env::var("NOMOREIDE_REMOTE_DISABLED")
        .map(|value| {
            !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "" | "0" | "false"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    /// The parsing, tested directly rather than through the environment, which
    /// is process-global and would make these tests order-dependent.
    fn disabled(value: &str) -> bool {
        !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false"
        )
    }

    #[test]
    fn the_switch_is_off_for_the_ways_people_write_off() {
        for value in ["0", "false", "FALSE", " false ", ""] {
            assert!(!disabled(value), "{value:?} should not disable");
        }
    }

    #[test]
    fn the_switch_is_on_for_the_ways_people_write_on() {
        for value in ["1", "true", "TRUE", "yes", "on"] {
            assert!(disabled(value), "{value:?} should disable");
        }
    }
}
